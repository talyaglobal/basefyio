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
  'Database size: shown against the limit and not cut off when it grows past it, but you cannot move to a plan it does not fit in.';

/** Compute in plain words: every project is on the shared server today. */
export const SHARED_COMPUTE_SENTENCE =
  'Your database runs on a shared PostgreSQL server together with other projects: it gets a share of the server’s CPU and memory, with no CPU or RAM reserved for it.';

export interface PlanLimits {
  name: string;
  displayName: string;
  /** Bytes as a string or number (the API sends BigInt as a string); null = no cap. */
  maxDbSizeBytes?: string | number | null;
  maxStorageBytes?: string | number | null;
  priceMonthly?: number;
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
