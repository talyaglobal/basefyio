import type { HostSample } from './host-reader';
import type { CapacityModelSnapshot, ProjectProfile, ResourceCeiling, SimulationInput, SimulationResult } from './capacity-model';

/** Everything the sampler could read in one minute. Any section may be null when its source was unreachable. */
export interface CapacityMetrics {
  host: HostSample | null;
  containers: Array<{ name: string; cpuPct: number | null; memMb: number | null }> | null;
  disk: { volumeBytes: number | null; usedBytes: number | null; usedPct: number | null; growAtPct: number | null; maxSizeGb: number | null } | null;
  postgres: {
    connections: number;
    maxConnections: number;
    byState: Record<string, number>;
    xactCommitPerMin: number | null;
    cacheHitPct: number | null;
    deadlocks: number | null;
    databases: number;
  } | null;
  pgbouncer: { pools: number; clientConns: number; serverConns: number; maxClientConn: number | null; defaultPoolSize: number | null } | null;
  redis: { usedMb: number; maxMb: number | null; keys: number; evictedKeys: number; opsPerSec: number | null } | null;
  api: {
    inflight: number;
    rpsRecent: number | null;
    p95Ms: number | null;
    errorPct: number | null;
    sseConnections: number;
    bullmq: Record<string, { waiting: number; active: number; failed: number }>;
  } | null;
  tenancy: {
    organizations: number;
    payingOrganizations: number;
    projects: { awake: number; asleep: number; nosql: number; total: number };
    dueToSleep: number | null;
    warned: number | null;
    apiRequestsMonth: number | null;
  } | null;
}

export interface CapacityOverview {
  sampledAt: string | null;
  fresh: boolean;
  enabled: boolean;
  seedValues: boolean;
  metrics: CapacityMetrics | null;
  model: CapacityModelSnapshot | null;
  recommendations: string[];
  ceilings: ResourceCeiling[];
  profile: ProjectProfile;
  apiReplicas: number;
  presets: Record<string, SimulationInput>;
  benchmark: { latest: { scenario: string; finishedAt: string | null; rps: number | null; p95: number | null } | null; rpsPerReplica: number; measured: boolean };
  /** 24-hour sparklines per resource key, oldest first, at 5-minute steps. */
  sparklines: Record<string, Array<{ ts: string; value: number | null }>>;
}

export type { SimulationInput, SimulationResult };
