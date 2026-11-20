import { DEFAULT_INFRA_COST_CONFIG } from '../billing/project-cost.pricing';

/**
 * Compute sizes a project can be created with, and the one region there is.
 *
 * `shared` is today's placement: the shared PostgreSQL server. The dedicated sizes are the
 * billing tier table (`project-cost.pricing.ts`) and reserve CPU and memory for one project;
 * they are offered only where the team's plan includes a dedicated database and the region
 * has room for one. Pure: no Nest, no database.
 */
export const COMPUTE_TIERS = ['shared', 'micro', 'small', 'medium', 'large', 'xl'] as const;
export type ComputeTierId = (typeof COMPUTE_TIERS)[number];

export const PROJECT_REGIONS = ['eu-central'] as const;
export type ProjectRegion = (typeof PROJECT_REGIONS)[number];
export const DEFAULT_REGION: ProjectRegion = 'eu-central';

export const REGION_LABELS: Record<ProjectRegion, string> = {
  'eu-central': 'EU (Germany)',
};

export interface DedicatedSize {
  cpuMillis: number;
  memoryMb: number;
}

/** CPU and memory a dedicated tier reserves, from the billing tier table. Null for `shared`. */
export function dedicatedSizeFor(tier: ComputeTierId): DedicatedSize | null {
  if (tier === 'shared') return null;
  const row = DEFAULT_INFRA_COST_CONFIG.computeTiers.find((t) => t.name.toLowerCase() === tier);
  if (!row) return null;
  return { cpuMillis: Math.round(row.vcpu * 1000), memoryMb: Math.round(row.memoryGb * 1024) };
}

export interface ComputePlacementContext {
  /** The team's plan includes a dedicated database. */
  planDedicated: boolean;
  /** Plan name shown to the customer, e.g. "Free". */
  planDisplayName: string;
  /** The region has a host declared to have room for dedicated databases. */
  regionHasCapacity: boolean;
}

/**
 * Why a requested compute tier cannot be placed, or null when it can. The server decides;
 * the dialog only mirrors this.
 */
export function computeTierRefusal(tier: ComputeTierId, ctx: ComputePlacementContext): string | null {
  if (tier === 'shared') return null;
  if (!ctx.planDedicated) {
    return `Dedicated compute is not available on the ${ctx.planDisplayName} plan`;
  }
  if (!ctx.regionHasCapacity) {
    return 'Dedicated compute is not available in this region yet';
  }
  return null;
}

export interface ComputeTierOption {
  id: ComputeTierId;
  label: string;
  vcpu: number | null;
  memoryGb: number | null;
  available: boolean;
  /** Why it is disabled; null when available. */
  reason: string | null;
}

export interface ComputeOptions {
  region: ProjectRegion;
  planAllowsDedicated: boolean;
  dedicatedAvailable: boolean;
  tiers: ComputeTierOption[];
}

/** What `GET /projects/compute-options` answers for one team. */
export function computeOptionsFor(ctx: ComputePlacementContext): ComputeOptions {
  const tiers: ComputeTierOption[] = [
    { id: 'shared', label: 'Shared', vcpu: null, memoryGb: null, available: true, reason: null },
  ];
  for (const row of DEFAULT_INFRA_COST_CONFIG.computeTiers) {
    const id = row.name.toLowerCase() as ComputeTierId;
    if (!COMPUTE_TIERS.includes(id)) continue;
    const reason = !ctx.planDedicated
      ? 'Pro and above'
      : !ctx.regionHasCapacity
        ? 'Not available in this region yet'
        : null;
    tiers.push({ id, label: row.name, vcpu: row.vcpu, memoryGb: row.memoryGb, available: reason === null, reason });
  }
  return {
    region: DEFAULT_REGION,
    planAllowsDedicated: ctx.planDedicated,
    dedicatedAvailable: ctx.planDedicated && ctx.regionHasCapacity,
    tiers,
  };
}
