import { DEFAULT_INFRA_COST_CONFIG, resolveComputeTier } from '../billing/project-cost.pricing';
import { DEFAULT_REGION, REGION_LABELS, type ProjectRegion } from './project-compute';

/**
 * What a project gets, in the words the project's Overview shows: where it
 * runs, what compute it has, and how much of the plan's database and file
 * storage limits it uses. Pure: no Nest, no database.
 *
 * Plan limits are per organization (the sum over its projects), because that is
 * how they are checked (`QuotaService`, `planLimitFindings`). A limit of null
 * means the plan has no cap (Legacy); it is never inferred from a missing value.
 */

/** Where the region's servers are. The cost model names the host's data centre (nbg1). */
export const REGION_LOCATIONS: Record<ProjectRegion, string> = {
  'eu-central': 'Nuremberg, Germany',
};

export interface ResourcesPlanInput {
  name: string;
  displayName: string;
  maxDbSizeBytes: bigint | null;
  maxStorageBytes: bigint | null;
}

export interface ResourcesInfraInput {
  status: string;
  pgMemoryMb: number;
  pgCpuMillis: number;
}

export interface ResourcesInput {
  plan: ResourcesPlanInput | null;
  /** The project's own measured sizes. */
  projectDbSizeBytes: bigint;
  projectStorageBytes: bigint;
  dbSizeMeasuredAt: Date | null;
  storageMeasuredAt: Date | null;
  /** The organization's totals, which the plan limits apply to. */
  orgDbSizeBytes: bigint;
  orgStorageBytes: bigint;
  /** Only an ACTIVE dedicated container reserves resources. */
  infrastructure: ResourcesInfraInput | null;
}

export interface MeteredResource {
  /** This project's share, in bytes. */
  projectBytes: number;
  /** The whole organization, in bytes: the figure the plan limit is compared with. */
  organizationBytes: number;
  /** The plan's cap in bytes; null = the plan has no cap. */
  limitBytes: number | null;
  measuredAt: string | null;
}

export interface ProjectResources {
  region: { id: ProjectRegion; label: string; location: string };
  compute: {
    mode: 'shared' | 'dedicated';
    /** `Shared`, or the tier name of a dedicated container. */
    label: string;
    vcpu: number | null;
    memoryGb: number | null;
    /** True when CPU and memory are reserved for this project alone. */
    reserved: boolean;
  };
  plan: { name: string; displayName: string } | null;
  /** True when the plan has no database and no file storage cap at all. */
  uncapped: boolean;
  database: MeteredResource;
  storage: MeteredResource;
}

const toLimit = (v: bigint | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export function buildProjectResources(input: ResourcesInput): ProjectResources {
  const infra = input.infrastructure && input.infrastructure.status === 'ACTIVE' ? input.infrastructure : null;
  let compute: ProjectResources['compute'];
  if (infra) {
    const tier = resolveComputeTier(DEFAULT_INFRA_COST_CONFIG, {
      dbSizeBytes: 0,
      dedicatedMemoryMb: infra.pgMemoryMb,
      dedicatedCpuMillis: infra.pgCpuMillis,
    });
    compute = {
      mode: 'dedicated',
      label: tier.name,
      vcpu: infra.pgCpuMillis / 1000,
      memoryGb: infra.pgMemoryMb / 1024,
      reserved: true,
    };
  } else {
    compute = { mode: 'shared', label: 'Shared', vcpu: null, memoryGb: null, reserved: false };
  }

  const dbLimit = toLimit(input.plan?.maxDbSizeBytes);
  const storageLimit = toLimit(input.plan?.maxStorageBytes);
  return {
    region: { id: DEFAULT_REGION, label: REGION_LABELS[DEFAULT_REGION], location: REGION_LOCATIONS[DEFAULT_REGION] },
    compute,
    plan: input.plan ? { name: input.plan.name, displayName: input.plan.displayName } : null,
    // No plan row is not "unlimited": only a plan that really has no caps is.
    uncapped: input.plan !== null && dbLimit === null && storageLimit === null,
    database: {
      projectBytes: Number(input.projectDbSizeBytes),
      organizationBytes: Number(input.orgDbSizeBytes),
      limitBytes: dbLimit,
      measuredAt: input.dbSizeMeasuredAt ? input.dbSizeMeasuredAt.toISOString() : null,
    },
    storage: {
      projectBytes: Number(input.projectStorageBytes),
      organizationBytes: Number(input.orgStorageBytes),
      limitBytes: storageLimit,
      measuredAt: input.storageMeasuredAt ? input.storageMeasuredAt.toISOString() : null,
    },
  };
}
