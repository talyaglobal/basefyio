/**
 * Plan limit enforcement: the pure rules. No database, no Redis, no clock of
 * its own, so every decision can be tested on its own.
 *
 * Four metered limits are enforced here: API requests and egress per month,
 * monthly active users, and database size. Each has a rollout mode, stored in
 * system_settings under PLAN_ENFORCEMENT_KEY and changeable by root without a
 * deploy:
 *
 *   off      nothing is evaluated for the metric
 *   warn     (default) nothing is ever refused; a team past its limit plus the
 *            grace is logged as `plan_limit_would_block` and shown in Billing
 *   enforce  past the limit plus the grace the request is refused (429 for
 *            requests and egress, 402 for database writes, 402 for new
 *            sign-ups); the owners are mailed at 80% and 100%
 *
 * Never enforced: Legacy and grandfathered plans (old terms), a null cap
 * (Enterprise by default), a cap of zero or less (treated as not set, so a
 * misconfigured row cannot lock a team out), and a monthly counter that still
 * belongs to an earlier month (the reset has not run: the figure is not this
 * month's).
 */
import { isGrandfatheredPlan, PlanLike } from './billing-plan-rules';

export const PLAN_ENFORCEMENT_KEY = 'plan_enforcement';

export const ENFORCED_METRICS = ['api_requests', 'egress', 'mau', 'db_size'] as const;
export type EnforcedMetric = (typeof ENFORCED_METRICS)[number];

export const ENFORCEMENT_MODES = ['off', 'warn', 'enforce'] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

export type EnforcementModes = Record<EnforcedMetric, EnforcementMode>;

export const DEFAULT_ENFORCEMENT_MODES: EnforcementModes = {
  api_requests: 'warn',
  egress: 'warn',
  mau: 'warn',
  db_size: 'warn',
};

/** Shares of the limit, in percent. */
export const WARN_PERCENT = 80;
export const LIMIT_PERCENT = 100;
/** Refused only past the limit plus this grace. */
export const GRACE_PERCENT = 110;

const isMode = (v: unknown): v is EnforcementMode =>
  typeof v === 'string' && (ENFORCEMENT_MODES as readonly string[]).includes(v);

/**
 * The stored setting as modes. Accepts `{ api_requests: 'enforce', ... }` or a
 * single string for every metric; anything missing or unknown is `warn`.
 */
export function parseEnforcementModes(value: unknown): EnforcementModes {
  const out: EnforcementModes = { ...DEFAULT_ENFORCEMENT_MODES };
  if (isMode(value)) {
    for (const m of ENFORCED_METRICS) out[m] = value;
    return out;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    for (const m of ENFORCED_METRICS) if (isMode(v[m])) out[m] = v[m] as EnforcementMode;
  }
  return out;
}

/** Validate a change sent by root: only known metrics and modes. Returns null when invalid. */
export function validateEnforcementPatch(body: unknown): Partial<EnforcementModes> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out: Partial<EnforcementModes> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!(ENFORCED_METRICS as readonly string[]).includes(k) || !isMode(v)) return null;
    out[k as EnforcedMetric] = v;
  }
  return Object.keys(out).length ? out : null;
}

export type UsageLevel = 'ok' | 'warning' | 'limit' | 'over_grace';

export interface UsageForEnforcement {
  apiRequestsMonth: number;
  bandwidthMonth: bigint;
  mauCount: number;
  dbSizeBytes: bigint;
  /** Start of the period the monthly counters belong to. */
  periodStart?: Date | null;
}

export interface MetricState {
  metric: EnforcedMetric;
  label: string;
  unit: 'count' | 'bytes';
  /** Strings so byte values survive JSON. */
  current: string;
  limit: string | null;
  /** Whole percent of the limit used, null without a cap. */
  percent: number | null;
  level: UsageLevel;
  mode: EnforcementMode;
  /** True when the metric is refused right now (enforce mode, past the grace). */
  blocking: boolean;
  /** True when it would be refused if the mode were enforce. */
  wouldBlock: boolean;
}

export interface TeamEnforcementState {
  planName: string | null;
  planDisplayName: string | null;
  /** Legacy/grandfathered or no plan: nothing is enforced. */
  exempt: boolean;
  exemptReason: string | null;
  metrics: MetricState[];
}

const LABELS: Record<EnforcedMetric, { label: string; unit: 'count' | 'bytes' }> = {
  api_requests: { label: 'API requests this month', unit: 'count' },
  egress: { label: 'Egress this month', unit: 'bytes' },
  mau: { label: 'Monthly active users', unit: 'count' },
  db_size: { label: 'Database size', unit: 'bytes' },
};

const toBig = (v: bigint | number | string | null | undefined): bigint | null => {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v as any);
  } catch {
    return null;
  }
};

/** Where `current` stands against `limit` (a positive cap). */
export function usageLevel(current: bigint, limit: bigint): UsageLevel {
  const c = current * BigInt(100);
  if (c >= limit * BigInt(GRACE_PERCENT)) return 'over_grace';
  if (c >= limit * BigInt(LIMIT_PERCENT)) return 'limit';
  if (c >= limit * BigInt(WARN_PERCENT)) return 'warning';
  return 'ok';
}

function monthStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** The plan's limit for a metric: null when there is none, or when it is zero or less. */
export function capFor(plan: PlanLike, metric: EnforcedMetric): bigint | null {
  const raw =
    metric === 'api_requests'
      ? plan.maxApiRequests
      : metric === 'egress'
        ? plan.maxBandwidthBytes
        : metric === 'mau'
          ? plan.maxMau
          : plan.maxDbSizeBytes;
  const cap = toBig(raw as any);
  return cap !== null && cap > BigInt(0) ? cap : null;
}

/** Evaluate every enforced metric of a team. Pure. */
export function evaluatePlanUsage(
  plan: PlanLike | null,
  usage: UsageForEnforcement | null,
  modes: EnforcementModes,
  now: Date = new Date(),
): TeamEnforcementState {
  const exemptReason = !plan
    ? 'no plan'
    : isGrandfatheredPlan(plan)
      ? 'legacy or grandfathered plan'
      : null;
  const exempt = exemptReason !== null;
  const staleMonth = !!usage?.periodStart && usage.periodStart.getTime() < monthStartUtc(now).getTime();

  const metrics: MetricState[] = ENFORCED_METRICS.map((metric) => {
    const mode = modes[metric];
    const current =
      !usage
        ? BigInt(0)
        : metric === 'api_requests'
          ? BigInt(usage.apiRequestsMonth || 0)
          : metric === 'egress'
            ? BigInt(usage.bandwidthMonth ?? 0)
            : metric === 'mau'
              ? BigInt(usage.mauCount || 0)
              : BigInt(usage.dbSizeBytes ?? 0);
    const cap = plan ? capFor(plan, metric) : null;
    const monthly = metric !== 'db_size';
    // A monthly figure from an earlier month is not this month's usage: never act on it.
    const level: UsageLevel = cap === null || (monthly && staleMonth) ? 'ok' : usageLevel(current, cap);
    const percent = cap === null ? null : Number((current * BigInt(100)) / cap);
    const wouldBlock = !exempt && mode !== 'off' && level === 'over_grace';
    return {
      metric,
      label: LABELS[metric].label,
      unit: LABELS[metric].unit,
      current: current.toString(),
      limit: cap === null ? null : cap.toString(),
      percent,
      level: exempt || mode === 'off' ? 'ok' : level,
      mode,
      wouldBlock,
      blocking: wouldBlock && mode === 'enforce',
    };
  });

  return {
    planName: plan?.name ?? null,
    planDisplayName: plan?.displayName ?? plan?.name ?? null,
    exempt,
    exemptReason,
    metrics,
  };
}

/** Human form of a figure for messages. */
export function formatFigure(value: string | null, unit: 'count' | 'bytes'): string {
  if (value === null) return 'unlimited';
  const n = Number(value);
  if (unit === 'count') return n.toLocaleString('en-US');
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (n >= GB) return `${(n / GB).toFixed(n % GB === 0 ? 0 : 1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(0)} MB`;
  return `${n} bytes`;
}
