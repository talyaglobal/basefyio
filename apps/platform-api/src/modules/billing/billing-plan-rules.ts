/**
 * Plan rules for cards and for moving to the Free plan. Pure functions, so the
 * rules can be tested without a database or the payment processor.
 */

export interface PlanLike {
  name: string;
  displayName?: string;
  priceMonthly: number;
  features?: unknown;
  maxProjects?: number | null;
  maxTeamMembers?: number | null;
  maxStorageBytes?: bigint | number | string | null;
  maxDbSizeBytes?: bigint | number | string | null;
  maxApiRequests?: number | null;
  maxBandwidthBytes?: bigint | number | string | null;
  maxMau?: number | null;
}

/** Legacy and grandfathered accounts keep their old terms: no card is ever required. */
export function isCardExempt(plan: PlanLike | null | undefined): boolean {
  if (!plan) return false;
  if (plan.name === 'legacy') return true;
  const features = plan.features as Record<string, unknown> | null | undefined;
  return !!features && typeof features === 'object' && features.grandfathered === true;
}

/** Legacy or grandfathered: the old terms, no caps enforced on it at all. */
export function isGrandfatheredPlan(plan: Pick<PlanLike, 'name' | 'features'> | null | undefined): boolean {
  if (!plan) return false;
  if (plan.name === 'legacy') return true;
  const features = plan.features as Record<string, unknown> | null | undefined;
  return !!features && typeof features === 'object' && features.grandfathered === true;
}

/**
 * Enterprise is arranged with sales: by name, or any plan whose features say
 * `enterprise: true`. It is not grandfathered: a cap set on its row (a
 * contract's custom limit) applies like any other plan's; a null cap is no cap.
 */
export function isEnterprisePlan(plan: Pick<PlanLike, 'name' | 'features'> | null | undefined): boolean {
  if (!plan) return false;
  if (plan.name === 'enterprise') return true;
  const features = plan.features as Record<string, unknown> | null | undefined;
  return !!features && typeof features === 'object' && features.enterprise === true;
}

/** A paid plan (price above zero, not legacy or grandfathered) must always have a card on file. */
export function planRequiresCard(plan: PlanLike | null | undefined): boolean {
  if (!plan) return false;
  return !isCardExempt(plan) && (plan.priceMonthly ?? 0) > 0;
}

export interface UsageSnapshot {
  projects: number;
  members: number;
  storageBytes: bigint;
  dbSizeBytes: bigint;
  apiRequestsMonth: number;
  bandwidthMonth: bigint;
  mau: number;
}

export interface LimitFinding {
  resource: 'projects' | 'members' | 'storage' | 'database' | 'api_requests' | 'bandwidth' | 'mau';
  label: string;
  unit: 'count' | 'bytes';
  /** Numbers as strings so byte values survive JSON. */
  current: string;
  limit: string;
  /** What the customer can do about it. */
  hint: string;
}

const toBig = (v: bigint | number | string | null | undefined): bigint | null =>
  v === null || v === undefined ? null : BigInt(v as any);

/**
 * Usage above the target plan's limits. `blockers` must be reduced before the
 * move (projects, members, storage, database size); `warnings` are this
 * month's metered counters, which reset monthly and never block (owner, 2026-11-20).
 * Nothing here deletes anything: it only lists what is over.
 */
export function planLimitFindings(
  target: PlanLike,
  usage: UsageSnapshot,
): { blockers: LimitFinding[]; warnings: LimitFinding[] } {
  const blockers: LimitFinding[] = [];
  const warnings: LimitFinding[] = [];
  const check = (
    list: LimitFinding[],
    resource: LimitFinding['resource'],
    label: string,
    unit: LimitFinding['unit'],
    current: bigint,
    limit: bigint | null,
    hint: string,
  ) => {
    if (limit !== null && current > limit) {
      list.push({ resource, label, unit, current: current.toString(), limit: limit.toString(), hint });
    }
  };

  check(blockers, 'projects', 'Projects', 'count', BigInt(usage.projects), toBig(target.maxProjects),
    'Delete or deactivate projects until you are within the limit.');
  check(blockers, 'members', 'Team members', 'count', BigInt(usage.members), toBig(target.maxTeamMembers),
    'Remove members from the organization until you are within the limit.');
  check(blockers, 'storage', 'File storage', 'bytes', usage.storageBytes, toBig(target.maxStorageBytes),
    'Delete files from your storage buckets until you are within the limit.');
  check(blockers, 'database', 'Database size', 'bytes', usage.dbSizeBytes, toBig(target.maxDbSizeBytes),
    'Delete data from your project databases until you are within the limit.');

  check(warnings, 'api_requests', 'API requests this month', 'count', BigInt(usage.apiRequestsMonth), toBig(target.maxApiRequests),
    'Resets monthly. Requests above the limit are refused after the move.');
  check(warnings, 'bandwidth', 'Bandwidth this month', 'bytes', usage.bandwidthMonth, toBig(target.maxBandwidthBytes),
    'Resets monthly. Traffic above the limit is refused after the move.');
  check(warnings, 'mau', 'Monthly active users', 'count', BigInt(usage.mau), toBig(target.maxMau),
    'Resets monthly. Sign-ins above the limit may be refused after the move.');

  return { blockers, warnings };
}

/** Invoice statuses that still owe money. */
export const UNPAID_INVOICE_STATUSES = ['open', 'unpaid', 'payment_failed'];

export function invoiceOutstanding(inv: { status?: string | null; amountDue: number; amountPaid: number }): number {
  if (!UNPAID_INVOICE_STATUSES.includes((inv.status || '').toLowerCase())) return 0;
  return Math.max(0, inv.amountDue - inv.amountPaid);
}
