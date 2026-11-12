/**
 * Pure helpers behind the team cost report under Billing: money rounded the
 * way it is shown, the rows that reconcile the project breakdown with the
 * team's usage counters, and the month-end snapshots that make up a past
 * period. No I/O, so every figure can be tested with concrete numbers.
 */
import {
  BillingPeriod,
  InfraCostConfig,
  ProjectCostReport,
  priceProject,
} from './project-cost.pricing';
import type { CustomerCostLine, CustomerProjectCost } from './project-cost.service';

/** Dollars rounded to whole cents — the precision every figure is shown at. */
export function cents(n: number): number {
  // toPrecision first so a value stored as 5.47499999… still rounds as 5.475.
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
}

/**
 * The customer's view of one project, in cents throughout: each line is
 * rounded to the cent first and the project amount is the sum of those
 * rounded lines. The report total is then the sum of the project amounts, so
 * what is shown always adds up — before, every figure was rounded on its own
 * and three rows of $1.83, $1.82 and $1.82 sat over a total of $5.48.
 */
export function toCustomerProjectView(r: ProjectCostReport): CustomerProjectCost {
  const lines: CustomerCostLine[] = r.lines.map((l) => ({
    key: l.key,
    label: l.label,
    quantity: l.quantity,
    unit: l.unit,
    detail: l.detail,
    amountUsd: cents(l.pricedUsd),
    projectedUsd: cents(l.projectedPricedUsd),
  }));
  return {
    projectId: r.projectId,
    name: r.name,
    slug: r.slug,
    status: r.status,
    computeTier: r.computeTier,
    activeHours: r.activeHours,
    lines,
    amountUsd: cents(lines.reduce((s, l) => s + l.amountUsd, 0)),
    projectedUsd: cents(lines.reduce((s, l) => s + l.projectedUsd, 0)),
  };
}

export type OtherUsageKey = 'inactive_projects' | 'unattributed';

/**
 * Usage the team's counters hold that no current project row shows. Listed
 * under the projects so the breakdown adds up to the same API requests and
 * egress as the Usage card.
 */
export interface CustomerUsageRow {
  key: OtherUsageKey;
  label: string;
  description: string;
  apiRequests: number;
  bandwidthBytes: number;
  lines: CustomerCostLine[];
  amountUsd: number;
  /** This usage does not grow any further, so the projection equals the amount. */
  projectedUsd: number;
}

export interface UsageAmounts {
  apiRequests: number;
  bandwidthBytes: number;
}

/** Per-project counters started here; earlier traffic was counted for the team only. */
export const PER_PROJECT_METERING_START = new Date('2026-10-08T00:00:00Z');

function otherUsageText(key: OtherUsageKey, period: BillingPeriod): { label: string; description: string } {
  if (key === 'inactive_projects') {
    return {
      label: 'Deleted and deactivated projects',
      description:
        'Traffic this period from projects that are now in the trash or deactivated. They no longer use compute or storage.',
    };
  }
  const beforeMetering = period.start < PER_PROJECT_METERING_START;
  return {
    label: beforeMetering ? 'Earlier and removed projects' : 'Removed projects',
    description: beforeMetering
      ? 'Traffic the team counted that no current project carries: usage recorded before per-project metering began on October 8, 2026, and usage of projects that were permanently deleted.'
      : 'Traffic the team counted that no current project carries: usage of projects that were permanently deleted.',
  };
}

/**
 * Split what the team counted into what the project rows show, what trashed
 * or deactivated projects used, and the remainder nothing carries any more.
 * Each part is floored at zero: a team counter that is short (it never gained
 * a project's earlier usage) leaves no negative row behind.
 */
export function reconcileTeamUsage(input: {
  team: UsageAmounts;
  projects: UsageAmounts;
  inactive: UsageAmounts;
}): { inactive: UsageAmounts; unattributed: UsageAmounts } {
  const left = {
    apiRequests: Math.max(0, input.team.apiRequests - input.projects.apiRequests),
    bandwidthBytes: Math.max(0, input.team.bandwidthBytes - input.projects.bandwidthBytes),
  };
  const inactive = {
    apiRequests: Math.min(left.apiRequests, Math.max(0, input.inactive.apiRequests)),
    bandwidthBytes: Math.min(left.bandwidthBytes, Math.max(0, input.inactive.bandwidthBytes)),
  };
  return {
    inactive,
    unattributed: {
      apiRequests: left.apiRequests - inactive.apiRequests,
      bandwidthBytes: left.bandwidthBytes - inactive.bandwidthBytes,
    },
  };
}

/**
 * Price an "other usage" row at the same egress and API rates as a project.
 * Only the traffic lines apply: nothing behind it occupies compute or storage.
 * Null when there is nothing to show.
 */
export function priceOtherUsage(
  cfg: InfraCostConfig,
  period: BillingPeriod,
  key: OtherUsageKey,
  amounts: UsageAmounts,
): CustomerUsageRow | null {
  if (amounts.apiRequests <= 0 && amounts.bandwidthBytes <= 0) return null;
  const text = otherUsageText(key, period);
  const report = priceProject(
    cfg,
    period,
    {
      id: key,
      name: text.label,
      slug: key,
      status: 'INACTIVE',
      createdAt: period.start,
      dbSizeBytes: 0,
      storageBytes: 0,
      apiRequests: amounts.apiRequests,
      bandwidthBytes: amounts.bandwidthBytes,
    },
    period.end,
  );
  const lines: CustomerCostLine[] = report.lines
    .filter((l) => l.key === 'egress' || l.key === 'api_requests')
    .map((l) => ({
      key: l.key,
      label: l.label,
      quantity: l.quantity,
      unit: l.unit,
      detail: l.detail,
      amountUsd: cents(l.pricedUsd),
      projectedUsd: cents(l.pricedUsd),
    }));
  const amountUsd = cents(lines.reduce((s, l) => s + l.amountUsd, 0));
  return {
    key,
    ...text,
    apiRequests: amounts.apiRequests,
    bandwidthBytes: amounts.bandwidthBytes,
    lines,
    amountUsd,
    projectedUsd: amountUsd,
  };
}

/** Totals that are, by construction, the sum of the rows shown. */
export function sumCustomerRows(
  projects: Array<{ amountUsd: number; projectedUsd: number }>,
  other: Array<{ amountUsd: number; projectedUsd: number }>,
): { amountUsd: number; projectedUsd: number } {
  const all = [...projects, ...other];
  return {
    amountUsd: cents(all.reduce((s, r) => s + r.amountUsd, 0)),
    projectedUsd: cents(all.reduce((s, r) => s + r.projectedUsd, 0)),
  };
}

/** `YYYY-MM` → that UTC calendar month, or null for anything else. */
export function parseUsagePeriod(key: string | undefined | null): BillingPeriod | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec((key ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

export interface SnapshotMetrics {
  apiRequests: number;
  bandwidthBytes: number;
  storageBytes: number;
  dbSizeBytes: number;
}

const emptyMetrics = (): SnapshotMetrics => ({ apiRequests: 0, bandwidthBytes: 0, storageBytes: 0, dbSizeBytes: 0 });

const METRIC_FIELD: Record<string, keyof SnapshotMetrics> = {
  api_requests: 'apiRequests',
  bandwidth: 'bandwidthBytes',
  storage_bytes: 'storageBytes',
  db_size_bytes: 'dbSizeBytes',
};

/**
 * Fold one month's UsageRecord rows (written when the month closed) into the
 * team's totals and one entry per project.
 */
export function aggregateUsageRecords(
  records: Array<{ projectId: string | null; metric: string; value: bigint | number }>,
): { team: SnapshotMetrics; projects: Map<string, SnapshotMetrics> } {
  const team = emptyMetrics();
  const projects = new Map<string, SnapshotMetrics>();
  for (const r of records) {
    const field = METRIC_FIELD[r.metric];
    if (!field) continue;
    const value = Number(r.value);
    if (!r.projectId) {
      team[field] += value;
      continue;
    }
    const entry = projects.get(r.projectId) ?? emptyMetrics();
    entry[field] += value;
    projects.set(r.projectId, entry);
  }
  return { team, projects };
}
