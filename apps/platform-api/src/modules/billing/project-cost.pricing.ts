/**
 * Pure pricing math behind the per-project cost breakdown shown under Billing.
 *
 * The model is deliberately simple and transparent:
 *
 * - Every project is assigned a **compute tier** (Micro … XL). Dedicated
 *   projects take the tier that covers their reserved CPU/RAM; projects on the
 *   shared Postgres are sized by their database footprint, because a bigger
 *   database takes a bigger share of shared buffers, cache and IO.
 * - A tier's hourly cost is the host's monthly bill scaled by the share of the
 *   host that tier reserves (the larger of its CPU share and its RAM share).
 * - Database and file storage are billed per GB-month at the block-storage
 *   rate, prorated to the time the project existed inside the period.
 * - Egress and API requests are metered per GB / per million requests.
 *
 * Every line carries both the **raw** figure (what the infrastructure costs
 * us) and the **priced** figure (raw × markup). Customers see the priced
 * figure; root sees both plus the margin.
 *
 * No I/O here — everything is a function of its inputs so it can be unit
 * tested without a database.
 */

export const INFRA_COST_CONFIG_KEY = 'infra_cost_config';

/** Industry convention for converting a monthly price into an hourly one. */
export const HOURS_PER_MONTH = 730;

const GB = 1024 ** 3;

export interface ComputeTier {
  name: string;
  vcpu: number;
  memoryGb: number;
}

export interface SharedTierRule {
  /** Upper bound (exclusive) of database size in GB; null = catch-all. */
  maxDbGb: number | null;
  tier: string;
}

export interface InfraCostConfig {
  currency: 'usd';
  /** Raw infrastructure cost × markup = customer price. */
  markup: number;
  server: {
    label: string;
    monthlyCostUsd: number;
    vcpu: number;
    memoryGb: number;
    /** Attached block-storage volume, used for the actual monthly bill. */
    volumeGb: number;
  };
  /** Block storage, per GB-month. Applies to database and file storage. */
  diskUsdPerGbMonth: number;
  /** Outbound traffic, per GB. */
  egressUsdPerGb: number;
  /** Per million API requests. 0 = included in compute. */
  apiRequestsUsdPerMillion: number;
  computeTiers: ComputeTier[];
  /** Shared-Postgres projects are sized by DB footprint, first match wins. */
  sharedTierByDbSize: SharedTierRule[];
}

/**
 * Seeded from the production host (Hetzner CPX31: 4 vCPU / 8 GB, AMD EPYC,
 * nbg1) plus Hetzner block-storage and traffic list prices converted to USD.
 * Root can change every figure from Admin → Infrastructure Costs.
 */
export const DEFAULT_INFRA_COST_CONFIG: InfraCostConfig = {
  currency: 'usd',
  markup: 2.5,
  server: {
    label: 'Hetzner CPX31 · 4 vCPU · 8 GB',
    monthlyCostUsd: 17,
    vcpu: 4,
    memoryGb: 8,
    volumeGb: 300,
  },
  diskUsdPerGbMonth: 0.057,
  egressUsdPerGb: 0.0011,
  apiRequestsUsdPerMillion: 0,
  computeTiers: [
    { name: 'Micro', vcpu: 0.25, memoryGb: 0.5 },
    { name: 'Small', vcpu: 0.5, memoryGb: 1 },
    { name: 'Medium', vcpu: 1, memoryGb: 2 },
    { name: 'Large', vcpu: 2, memoryGb: 4 },
    { name: 'XL', vcpu: 4, memoryGb: 8 },
  ],
  sharedTierByDbSize: [
    { maxDbGb: 1, tier: 'Micro' },
    { maxDbGb: 5, tier: 'Small' },
    { maxDbGb: 20, tier: 'Medium' },
    { maxDbGb: 50, tier: 'Large' },
    { maxDbGb: null, tier: 'XL' },
  ],
};

export interface BillingPeriod {
  start: Date;
  end: Date;
}

export type CostLineKey = 'compute' | 'database' | 'storage' | 'egress' | 'api_requests';

export interface CostLine {
  key: CostLineKey;
  label: string;
  /** Metered quantity in `unit`. */
  quantity: number;
  unit: 'hours' | 'GB' | 'requests';
  /** Short human-readable detail, e.g. "Micro · 167 h" or "2.4 GB". */
  detail: string;
  /** Our cost so far in the period. */
  rawUsd: number;
  /** rawUsd × markup — what the customer sees. */
  pricedUsd: number;
  /** Linear projection to the end of the period. */
  projectedRawUsd: number;
  projectedPricedUsd: number;
}

export interface ProjectUsageInput {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  dbSizeBytes: number;
  storageBytes: number;
  apiRequests: number;
  bandwidthBytes: number;
  /** Reserved resources for dedicated projects; null/0 = shared Postgres. */
  dedicatedMemoryMb?: number | null;
  dedicatedCpuMillis?: number | null;
}

export interface ProjectCostReport {
  projectId: string;
  name: string;
  slug: string;
  status: string;
  computeTier: string;
  activeHours: number;
  dbSizeBytes: number;
  storageBytes: number;
  apiRequests: number;
  bandwidthBytes: number;
  lines: CostLine[];
  rawUsd: number;
  pricedUsd: number;
  projectedRawUsd: number;
  projectedPricedUsd: number;
}

export interface PeriodProgress {
  start: string;
  end: string;
  now: string;
  totalHours: number;
  elapsedHours: number;
  /** 0..1 */
  elapsedFraction: number;
  daysLeft: number;
}

const round = (n: number, places = 4) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const hoursBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 3_600_000);

export function describePeriod(period: BillingPeriod, now: Date): PeriodProgress {
  const totalHours = Math.max(hoursBetween(period.start, period.end), 1);
  const elapsedHours = Math.min(hoursBetween(period.start, now), totalHours);
  return {
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    now: now.toISOString(),
    totalHours: round(totalHours, 2),
    elapsedHours: round(elapsedHours, 2),
    elapsedFraction: round(elapsedHours / totalHours, 6),
    daysLeft: Math.max(0, Math.ceil(hoursBetween(now, period.end) / 24)),
  };
}

/** Hourly raw cost of a tier: host bill × the host share the tier reserves. */
export function tierHourlyRawUsd(tier: ComputeTier, server: InfraCostConfig['server']): number {
  const vcpu = server.vcpu > 0 ? tier.vcpu / server.vcpu : 0;
  const mem = server.memoryGb > 0 ? tier.memoryGb / server.memoryGb : 0;
  const share = Math.max(vcpu, mem);
  return (server.monthlyCostUsd * share) / HOURS_PER_MONTH;
}

export function resolveComputeTier(
  cfg: InfraCostConfig,
  input: Pick<ProjectUsageInput, 'dbSizeBytes' | 'dedicatedMemoryMb' | 'dedicatedCpuMillis'>,
): ComputeTier {
  const tiers = cfg.computeTiers.length ? cfg.computeTiers : DEFAULT_INFRA_COST_CONFIG.computeTiers;
  const sorted = [...tiers].sort(
    (a, b) => Math.max(a.vcpu, a.memoryGb) - Math.max(b.vcpu, b.memoryGb),
  );

  const memMb = input.dedicatedMemoryMb ?? 0;
  const cpuM = input.dedicatedCpuMillis ?? 0;
  if (memMb > 0 || cpuM > 0) {
    const fit = sorted.find((t) => t.memoryGb * 1024 >= memMb && t.vcpu * 1000 >= cpuM);
    return fit ?? sorted[sorted.length - 1];
  }

  const dbGb = input.dbSizeBytes / GB;
  const rules = cfg.sharedTierByDbSize.length
    ? cfg.sharedTierByDbSize
    : DEFAULT_INFRA_COST_CONFIG.sharedTierByDbSize;
  const rule = rules.find((r) => r.maxDbGb === null || dbGb < r.maxDbGb) ?? rules[rules.length - 1];
  return sorted.find((t) => t.name === rule.tier) ?? sorted[0];
}

const fmtGb = (bytes: number) => {
  const gb = bytes / GB;
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 ** 2;
  return mb >= 1 ? `${mb.toFixed(0)} MB` : `${Math.round(bytes / 1024)} KB`;
};

const fmtCount = (n: number) => n.toLocaleString('en-US');

/**
 * Price one project for the period. `now` is injected so projections are
 * reproducible in tests.
 */
export function priceProject(
  cfg: InfraCostConfig,
  period: BillingPeriod,
  input: ProjectUsageInput,
  now: Date,
): ProjectCostReport {
  const markup = cfg.markup > 0 ? cfg.markup : 1;
  const totalHours = Math.max(hoursBetween(period.start, period.end), 1);
  const clampedNow = now < period.start ? period.start : now > period.end ? period.end : now;
  const elapsedHours = hoursBetween(period.start, clampedNow);
  // Never divide by less than a day — linear projection on hour one is noise.
  const projectionDivisor = Math.max(elapsedHours / totalHours, Math.min(24 / totalHours, 1));

  // The window in which the project existed inside this period.
  const existsFrom = input.createdAt > period.start ? input.createdAt : period.start;
  const existedHours = existsFrom < clampedNow ? hoursBetween(existsFrom, clampedNow) : 0;
  const willExistHours = existsFrom < period.end ? hoursBetween(existsFrom, period.end) : 0;
  const existedFraction = existedHours / totalHours;
  const willExistFraction = willExistHours / totalHours;

  const isActive = input.status === 'ACTIVE';
  const tier = resolveComputeTier(cfg, input);
  const hourly = tierHourlyRawUsd(tier, cfg.server);
  const activeHours = isActive ? existedHours : 0;
  const projectedHours = isActive ? willExistHours : 0;

  const periodMonths = totalHours / HOURS_PER_MONTH;
  const diskRate = cfg.diskUsdPerGbMonth * periodMonths; // per GB for this period
  const dbGb = input.dbSizeBytes / GB;
  const storageGb = input.storageBytes / GB;
  const egressGb = input.bandwidthBytes / GB;

  const line = (
    key: CostLineKey,
    label: string,
    quantity: number,
    unit: CostLine['unit'],
    detail: string,
    rawUsd: number,
    projectedRawUsd: number,
  ): CostLine => ({
    key,
    label,
    quantity: round(quantity, 4),
    unit,
    detail,
    rawUsd: round(rawUsd),
    pricedUsd: round(rawUsd * markup),
    projectedRawUsd: round(projectedRawUsd),
    projectedPricedUsd: round(projectedRawUsd * markup),
  });

  const egressRaw = egressGb * cfg.egressUsdPerGb;
  const apiRaw = (input.apiRequests / 1_000_000) * cfg.apiRequestsUsdPerMillion;

  const lines: CostLine[] = [
    line(
      'compute',
      'Compute',
      activeHours,
      'hours',
      `${tier.name} · ${Math.round(activeHours)} h`,
      hourly * activeHours,
      hourly * projectedHours,
    ),
    line(
      'database',
      'Database storage',
      dbGb,
      'GB',
      fmtGb(input.dbSizeBytes),
      dbGb * diskRate * existedFraction,
      dbGb * diskRate * willExistFraction,
    ),
    line(
      'storage',
      'File storage',
      storageGb,
      'GB',
      fmtGb(input.storageBytes),
      storageGb * diskRate * existedFraction,
      storageGb * diskRate * willExistFraction,
    ),
    line(
      'egress',
      'Egress',
      egressGb,
      'GB',
      fmtGb(input.bandwidthBytes),
      egressRaw,
      egressRaw / projectionDivisor,
    ),
    line(
      'api_requests',
      'API requests',
      input.apiRequests,
      'requests',
      `${fmtCount(input.apiRequests)} requests`,
      apiRaw,
      apiRaw / projectionDivisor,
    ),
  ];

  const sum = (pick: (l: CostLine) => number) => round(lines.reduce((s, l) => s + pick(l), 0));

  return {
    projectId: input.id,
    name: input.name,
    slug: input.slug,
    status: input.status,
    computeTier: tier.name,
    activeHours: round(activeHours, 2),
    dbSizeBytes: input.dbSizeBytes,
    storageBytes: input.storageBytes,
    apiRequests: input.apiRequests,
    bandwidthBytes: input.bandwidthBytes,
    lines,
    rawUsd: sum((l) => l.rawUsd),
    pricedUsd: sum((l) => l.pricedUsd),
    projectedRawUsd: sum((l) => l.projectedRawUsd),
    projectedPricedUsd: sum((l) => l.projectedPricedUsd),
  };
}

export interface CostTotals {
  rawUsd: number;
  pricedUsd: number;
  projectedRawUsd: number;
  projectedPricedUsd: number;
}

export function sumProjectCosts(reports: ProjectCostReport[]): CostTotals {
  const total = (pick: (r: ProjectCostReport) => number) =>
    round(reports.reduce((s, r) => s + pick(r), 0));
  return {
    rawUsd: total((r) => r.rawUsd),
    pricedUsd: total((r) => r.pricedUsd),
    projectedRawUsd: total((r) => r.projectedRawUsd),
    projectedPricedUsd: total((r) => r.projectedPricedUsd),
  };
}

/**
 * Merge a stored (possibly partial, possibly stale-shaped) config over the
 * defaults. Non-finite or non-positive numbers fall back so a bad edit can
 * never zero out every price.
 */
export function mergeInfraCostConfig(stored: unknown): InfraCostConfig {
  const d = DEFAULT_INFRA_COST_CONFIG;
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<InfraCostConfig> & {
    server?: Partial<InfraCostConfig['server']>;
  };
  const pos = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  const nonNeg = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

  const tiers = Array.isArray(s.computeTiers)
    ? s.computeTiers
        .filter(
          (t): t is ComputeTier =>
            !!t && typeof t.name === 'string' && t.name.trim().length > 0 && pos(t.vcpu, 0) > 0 && pos(t.memoryGb, 0) > 0,
        )
        .map((t) => ({ name: t.name.trim(), vcpu: t.vcpu, memoryGb: t.memoryGb }))
    : [];
  const rules = Array.isArray(s.sharedTierByDbSize)
    ? s.sharedTierByDbSize.filter(
        (r): r is SharedTierRule =>
          !!r && typeof r.tier === 'string' && (r.maxDbGb === null || pos(r.maxDbGb, 0) > 0),
      )
    : [];

  return {
    currency: 'usd',
    markup: pos(s.markup, d.markup),
    server: {
      label:
        typeof s.server?.label === 'string' && s.server.label.trim() ? s.server.label.trim() : d.server.label,
      monthlyCostUsd: pos(s.server?.monthlyCostUsd, d.server.monthlyCostUsd),
      vcpu: pos(s.server?.vcpu, d.server.vcpu),
      memoryGb: pos(s.server?.memoryGb, d.server.memoryGb),
      volumeGb: nonNeg(s.server?.volumeGb, d.server.volumeGb),
    },
    diskUsdPerGbMonth: nonNeg(s.diskUsdPerGbMonth, d.diskUsdPerGbMonth),
    egressUsdPerGb: nonNeg(s.egressUsdPerGb, d.egressUsdPerGb),
    apiRequestsUsdPerMillion: nonNeg(s.apiRequestsUsdPerMillion, d.apiRequestsUsdPerMillion),
    computeTiers: tiers.length ? tiers : d.computeTiers,
    sharedTierByDbSize: rules.length ? rules : d.sharedTierByDbSize,
  };
}
