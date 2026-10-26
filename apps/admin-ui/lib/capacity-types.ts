/** Mirrors apps/platform-api/src/modules/capacity/{capacity-model,capacity.types}.ts. */

export type ResourceKey = 'pg_connections' | 'pgbouncer_clients' | 'host_cpu' | 'host_memory' | 'disk' | 'redis_memory' | 'api_rps';

export interface ResourceCeiling {
  key: ResourceKey;
  ceiling: number;
  target: number;
  measured: boolean;
}

export interface ProjectProfile {
  rps: number;
  dbConnections: number;
  poolerClients: number;
  dbGb: number;
  storageGb: number;
  sseClients: number;
  memoryMb: number;
  coresPerRps: number;
  redisMb: number;
}

export interface ResourceOutlook {
  key: ResourceKey;
  label: string;
  unit: string;
  ceiling: number;
  target: number;
  measured: boolean;
  current: number;
  utilization: number;
  baseline: number;
  perProject: number;
  maxProjects: number | null;
  maxProjectsAllAwake: number | null;
}

export interface CapacityModelSnapshot {
  perResource: ResourceOutlook[];
  bottleneck: ResourceKey | null;
  bottleneckAllAwake: ResourceKey | null;
  maxProjects: number | null;
  maxProjectsAllAwake: number | null;
  maxOrganizations: number | null;
  currentProjects: number;
  awakeProjects: number;
  asleepProjects: number;
  awakeShare: number;
  headroomProjects: number | null;
  headroomPct: number | null;
  confidence: number;
}

export interface SimulationNode {
  role: 'app' | 'db' | 'core' | 'all';
  vcpu: number;
  ramGb: number;
  diskGb: number;
}

export interface SimulationInput {
  projects: number;
  awakeShare: number;
  rpsPerProject: number;
  dbConnectionsPerProject: number;
  dbGbPerProject: number;
  storageGbPerProject: number;
  sseClientsPerProject: number;
  apiReplicas: number;
  nodes?: SimulationNode[];
  brokerEnabled?: boolean;
  ceilings?: Partial<Record<ResourceKey, number>>;
}

export interface SimulationResource {
  key: ResourceKey;
  label: string;
  unit: string;
  ceiling: number;
  target: number;
  usage: number;
  utilization: number;
  saturatesAt: number | null;
}

export interface SimulationResult {
  input: SimulationInput;
  resources: SimulationResource[];
  firstSaturated: ResourceKey | null;
  fits: boolean;
  nextStep: string;
}

export interface HostSample {
  cpuPct: number | null;
  cores: number;
  memTotalMb: number;
  memUsedMb: number;
  memAvailableMb: number;
  load1: number;
  load5: number;
  load15: number;
  source: 'host' | 'container';
}

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
  sparklines: Record<string, Array<{ ts: string; value: number | null }>>;
}

export interface CapacityHistoryPoint {
  ts: string;
  maxProjects: number | null;
  maxProjectsAllAwake: number | null;
  currentProjects: number;
  awakeProjects: number;
  bottleneck: ResourceKey | null;
}

export interface CapacityBenchmarkRun {
  id: string;
  scenario: string;
  target: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  startedAt: string;
  finishedAt: string | null;
  params: Record<string, unknown> | null;
  result: { rps?: number; p50?: number; p95?: number; p99?: number; errorRate?: number; byStage?: Array<Record<string, unknown>> } | null;
  triggeredBy: string | null;
}
