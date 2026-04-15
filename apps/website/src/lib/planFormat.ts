/** Shared formatting for billing / plan data (aligned with admin-ui signup helpers). */

export type PublicPlan = {
  id: string;
  name: string;
  displayName: string;
  maxProjects: number | null;
  maxStorageBytes: string | number | bigint | null;
  maxTeamMembers: number | null;
  maxDbSizeBytes?: string | number | bigint | null;
  maxApiRequests: number | null;
  maxBandwidthBytes?: string | number | bigint | null;
  maxMau?: number | null;
  dedicatedDb: boolean;
  dedicatedStorage: boolean;
  dbMemoryMb: number;
  dbCpuMillis: number;
  priceMonthly: number;
  isPublic: boolean;
  features?: unknown;
};

export function formatPlanPrice(priceMonthly: number): string {
  if (priceMonthly <= 0) return '$0';
  return `$${(priceMonthly / 100).toFixed(0)}/mo`;
}

export function formatPlanSubtitle(plan: Pick<PublicPlan, 'maxProjects' | 'maxStorageBytes'>): string {
  const projects =
    plan.maxProjects === null || plan.maxProjects === undefined
      ? 'Unlimited projects'
      : `Up to ${plan.maxProjects} projects`;
  const storage =
    plan.maxStorageBytes === null || plan.maxStorageBytes === undefined
      ? 'Flexible storage'
      : `~${Math.max(1, Math.round(Number(plan.maxStorageBytes) / (1024 * 1024 * 1024)))} GB storage`;
  return `${projects} · ${storage}`;
}

export function formatPlanBullets(plan: PublicPlan): string[] {
  const lines: string[] = [];
  if (plan.maxProjects != null) {
    lines.push(`${plan.maxProjects} projects`);
  } else {
    lines.push('Unlimited projects');
  }
  if (plan.maxStorageBytes != null) {
    const gb = Math.max(1, Math.round(Number(plan.maxStorageBytes) / (1024 * 1024 * 1024)));
    lines.push(`${gb} GB storage`);
  } else {
    lines.push('Flexible storage');
  }
  if (plan.maxTeamMembers != null) {
    lines.push(`Up to ${plan.maxTeamMembers} team members`);
  } else {
    lines.push('Unlimited team members');
  }
  if (plan.dedicatedDb) {
    lines.push('Dedicated database');
  }
  if (plan.dedicatedStorage) {
    lines.push('Dedicated storage');
  }
  if (plan.maxApiRequests != null) {
    lines.push(`API: ${plan.maxApiRequests.toLocaleString('en-US')} requests / month`);
  } else {
    lines.push('Flexible API quota');
  }
  if (plan.dbMemoryMb > 0) {
    lines.push(`DB memory: ${plan.dbMemoryMb} MB`);
  }
  return lines;
}
