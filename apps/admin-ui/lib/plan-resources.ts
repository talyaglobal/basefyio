import { formatBytes } from '@/lib/format';

/** Where the pricing and limits are explained in full. */
export const PRICING_DOCS_URL = `${process.env.NEXT_PUBLIC_DOCS_URL || 'https://basefyio.com'}/docs/pricing-and-limits`;

/** Enterprise is arranged with our team, never bought in the dashboard. */
export const ENTERPRISE_CONTACT_HREF = 'mailto:support@talyasmart.com?subject=basefyio%20Enterprise';

/** The one region there is today, in the words customers read. */
export const REGION_SUMMARY = 'EU (Germany) · Nuremberg';

/**
 * How storage is billed. Verified in the billing code: a plan is charged at its flat
 * monthly price (the subscription); database and file storage are measured and shown
 * in Billing as an estimate at standard usage rates, never added to the invoice.
 */
export const STORAGE_BILLING_SENTENCE =
  'Storage is not billed per GB or per MB: the plan’s flat monthly price covers it, up to the plan’s limits.';

/** What happens at each limit (verified in QuotaService and the plan-change rules). */
export const FILE_LIMIT_SENTENCE =
  'File storage: uploads that would go over the limit are refused until you delete files or upgrade.';
export const DB_LIMIT_SENTENCE =
  'Database size: measured every hour. Once enforced, writes that add data are refused past the limit plus a 10% grace; reading and deleting always work. You cannot move to a plan it does not fit in.';

/** The plan limits whose enforcement root can roll out per metric (off | warn | enforce). */
export type EnforcedMetric = 'api_requests' | 'egress' | 'mau' | 'db_size';
export type EnforcementMode = 'off' | 'warn' | 'enforce';

/** What is refused once a metric is past its limit plus the 10% grace, in enforce mode. */
export function blockedSentence(metric: EnforcedMetric): string {
  switch (metric) {
    case 'api_requests':
      return 'API requests are refused (HTTP 429) until the counter resets on the 1st (UTC).';
    case 'egress':
      return 'Requests are refused (HTTP 429) until the counter resets on the 1st (UTC).';
    case 'mau':
      return 'New sign-ups to your projects are refused (HTTP 402); existing users keep signing in.';
    case 'db_size':
      return 'Writes that add data are refused (HTTP 402); reading and deleting still work.';
  }
}

const METRIC_NAME: Record<EnforcedMetric, string> = {
  api_requests: 'API requests',
  egress: 'Egress',
  mau: 'Monthly active users',
  db_size: 'Database size',
};

/**
 * Exactly what a limit does today, by its rollout mode (verified against
 * plan-enforcement.rules.ts in platform-api): `warn` and `off` never refuse
 * anything; `enforce` refuses past the limit plus a 10% grace and mails the
 * owners at 80% and 100%. Legacy plans and limits left empty are never enforced.
 */
export function enforcementSentence(metric: EnforcedMetric, mode: EnforcementMode): string {
  const name = METRIC_NAME[metric];
  if (mode === 'enforce') {
    const what = blockedSentence(metric);
    return `${name}: enforced. Owners are mailed at 80% and 100%; past the limit plus a 10% grace, ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
  }
  return `${name}: counted and shown against the limit; not refused at present.`;
}

/** Compute in plain words: every project is on the shared server today. */
export const SHARED_COMPUTE_SENTENCE =
  'Your database runs on a shared PostgreSQL server together with other projects: it gets a share of the server’s CPU and memory, with no CPU or RAM reserved for it.';

export interface PlanLimits {
  name: string;
  displayName: string;
  /** Bytes as a string or number (the API sends BigInt as a string); null = no cap. */
  maxDbSizeBytes?: string | number | null;
  maxStorageBytes?: string | number | null;
  /** null = no cap. */
  maxProjects?: number | null;
  priceMonthly?: number;
}

/**
 * True when the organization already holds its plan's maximum number of projects,
 * judged from the same team usage row the server's quota check reads. Unknown
 * inputs never block: the server stays the authority (it answers 402).
 */
export function projectLimitReached(
  projectCount: number | null | undefined,
  plan: PlanLimits | null | undefined,
): boolean {
  if (typeof projectCount !== 'number' || !plan) return false;
  const max = plan.maxProjects;
  return typeof max === 'number' && projectCount >= max;
}

/** A limit as words: the byte size, or `Unlimited` only when the plan has no cap. */
export function limitLabel(bytes: string | number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Unlimited';
  const n = Number(bytes);
  return Number.isFinite(n) ? formatBytes(n) : 'Unlimited';
}

/**
 * The limits of the organization's plan, or null when they are not known (a custom plan
 * the public list does not carry). Legacy is the plan with no caps. Never guesses.
 */
export function resolvePlanLimits(
  planName: string | null | undefined,
  publicPlans: PlanLimits[],
): PlanLimits | null {
  if (!planName) return null;
  const found = publicPlans.find((p) => p.name === planName);
  if (found) return found;
  if (planName === 'legacy') {
    return { name: 'legacy', displayName: 'Legacy', maxDbSizeBytes: null, maxStorageBytes: null };
  }
  return null;
}
