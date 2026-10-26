/**
 * The capacity model, free of Prisma and clocks: given what each resource
 * can hold, what one project costs and where we are, it says how many more
 * projects fit, which resource gives out first, and what a hypothetical
 * platform would do. Every number here is a straight line: usage of a
 * resource is a fixed overhead plus a per-project cost, and projects that
 * are asleep cost only disk.
 */

export const RESOURCE_KEYS = [
  'pg_connections',
  'pgbouncer_clients',
  'host_cpu',
  'host_memory',
  'disk',
  'redis_memory',
  'api_rps',
] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

export const RESOURCE_LABELS: Record<ResourceKey, string> = {
  pg_connections: 'Postgres connections',
  pgbouncer_clients: 'Pooler client connections',
  host_cpu: 'Host CPU',
  host_memory: 'Host memory',
  disk: 'Disk',
  redis_memory: 'Redis memory',
  api_rps: 'API throughput',
};

export const RESOURCE_UNITS: Record<ResourceKey, string> = {
  pg_connections: 'connections',
  pgbouncer_clients: 'connections',
  host_cpu: 'cores',
  host_memory: 'MB',
  disk: 'GB',
  redis_memory: 'MB',
  api_rps: 'req/s',
};

/** Utilization above which a resource is treated as full: 70 %, disk 85 %. */
export const DEFAULT_TARGETS: Record<ResourceKey, number> = {
  pg_connections: 0.7,
  pgbouncer_clients: 0.7,
  host_cpu: 0.7,
  host_memory: 0.7,
  disk: 0.85,
  redis_memory: 0.7,
  api_rps: 0.7,
};

export interface ResourceCeiling {
  key: ResourceKey;
  /** Absolute capacity in the resource's unit. */
  ceiling: number;
  /** 0..1, share of the ceiling we allow ourselves to use. */
  target: number;
  /** False when the value is a placeholder rather than something read from the system. */
  measured: boolean;
}

/** What one awake project costs, per resource unit, as a 7-day mean of the busier half. */
export interface ProjectProfile {
  rps: number;
  dbConnections: number;
  /** Pooler client connections per awake project (dashboard + SDK clients). */
  poolerClients: number;
  dbGb: number;
  storageGb: number;
  sseClients: number;
  /** Host memory per awake project (pool, backends, caches), in MB. */
  memoryMb: number;
  /** CPU cores consumed per 1 req/s of this project's traffic. */
  coresPerRps: number;
  /** Redis memory per awake project (rate-limit keys, usage counters, caches), in MB. */
  redisMb: number;
}

export interface CurrentState {
  awakeProjects: number;
  asleepProjects: number;
  organizations: number;
  /** Organizations on a paid plan; customers ≈ projects ÷ projects per paying organization. */
  payingOrganizations: number;
  /** Current absolute usage per resource, in the resource's unit. */
  usage: Record<ResourceKey, number>;
}

export interface ModelInputs {
  ceilings: ResourceCeiling[];
  profile: ProjectProfile;
  current: CurrentState;
  /** The API replica count the ceilings were measured with. */
  apiReplicas: number;
}

export interface ResourceOutlook {
  key: ResourceKey;
  label: string;
  unit: string;
  ceiling: number;
  target: number;
  measured: boolean;
  current: number;
  /** Current ÷ ceiling. */
  utilization: number;
  /** Usage not explained by projects (overhead), floored at zero. */
  baseline: number;
  perProject: number;
  /** Projects this resource can hold at the target before it is full (today's awake share). */
  maxProjects: number | null;
  /** Projects this resource can hold if every project were awake. */
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
  /** 0..1: share of ceilings that were measured rather than assumed. */
  confidence: number;
}

/** Per-project cost of a resource for an awake project and for any project (asleep ones hold disk). */
function perProjectCost(key: ResourceKey, p: ProjectProfile): { awake: number; any: number } {
  switch (key) {
    case 'pg_connections':
      return { awake: p.dbConnections, any: 0 };
    case 'pgbouncer_clients':
      return { awake: p.poolerClients, any: 0 };
    case 'host_cpu':
      return { awake: p.coresPerRps * p.rps, any: 0 };
    case 'host_memory':
      return { awake: p.memoryMb, any: 0 };
    case 'disk':
      return { awake: 0, any: p.dbGb + p.storageGb };
    case 'redis_memory':
      return { awake: p.redisMb, any: 0 };
    case 'api_rps':
      return { awake: p.rps, any: 0 };
  }
}

/** Usage of a resource for N projects of which `awakeShare` are awake. */
function usageFor(key: ResourceKey, baseline: number, p: ProjectProfile, projects: number, awakeShare: number): number {
  const cost = perProjectCost(key, p);
  return baseline + projects * awakeShare * cost.awake + projects * cost.any;
}

function maxProjectsFor(key: ResourceKey, baseline: number, p: ProjectProfile, ceiling: number, target: number, awakeShare: number): number | null {
  const cost = perProjectCost(key, p);
  const perProject = awakeShare * cost.awake + cost.any;
  if (perProject <= 0) return null;
  const room = ceiling * target - baseline;
  return Math.max(0, Math.floor(room / perProject));
}

export function computeModel(inputs: ModelInputs): CapacityModelSnapshot {
  const { profile, current } = inputs;
  const total = current.awakeProjects + current.asleepProjects;
  const awakeShare = total > 0 ? current.awakeProjects / total : 1;

  const perResource: ResourceOutlook[] = inputs.ceilings.map((c) => {
    const cost = perProjectCost(c.key, profile);
    const attributed = current.awakeProjects * cost.awake + total * cost.any;
    const currentUsage = current.usage[c.key] ?? 0;
    const baseline = Math.max(0, currentUsage - attributed);
    return {
      key: c.key,
      label: RESOURCE_LABELS[c.key],
      unit: RESOURCE_UNITS[c.key],
      ceiling: c.ceiling,
      target: c.target,
      measured: c.measured,
      current: currentUsage,
      utilization: c.ceiling > 0 ? currentUsage / c.ceiling : 0,
      baseline,
      perProject: awakeShare * cost.awake + cost.any,
      maxProjects: maxProjectsFor(c.key, baseline, profile, c.ceiling, c.target, awakeShare),
      maxProjectsAllAwake: maxProjectsFor(c.key, baseline, profile, c.ceiling, c.target, 1),
    };
  });

  const pick = (field: 'maxProjects' | 'maxProjectsAllAwake') => {
    let best: ResourceOutlook | null = null;
    for (const r of perResource) {
      if (r[field] === null) continue;
      if (!best || (r[field] as number) < (best[field] as number)) best = r;
    }
    return best;
  };
  const b = pick('maxProjects');
  const bAll = pick('maxProjectsAllAwake');
  const maxProjects = b?.maxProjects ?? null;
  const maxProjectsAllAwake = bAll?.maxProjectsAllAwake ?? null;
  const projectsPerPayingOrg = current.payingOrganizations > 0 ? total / current.payingOrganizations : null;
  const measured = inputs.ceilings.filter((c) => c.measured).length;

  return {
    perResource,
    bottleneck: b?.key ?? null,
    bottleneckAllAwake: bAll?.key ?? null,
    maxProjects,
    maxProjectsAllAwake,
    maxOrganizations: maxProjects !== null && projectsPerPayingOrg ? Math.floor(maxProjects / projectsPerPayingOrg) : null,
    currentProjects: total,
    awakeProjects: current.awakeProjects,
    asleepProjects: current.asleepProjects,
    awakeShare: Math.round(awakeShare * 1000) / 1000,
    headroomProjects: maxProjects !== null ? Math.max(0, maxProjects - total) : null,
    headroomPct: maxProjects !== null && maxProjects > 0 ? Math.round(Math.max(0, (maxProjects - total) / maxProjects) * 1000) / 10 : null,
    confidence: inputs.ceilings.length ? Math.round((measured / inputs.ceilings.length) * 100) / 100 : 0,
  };
}

// ── Simulation ───────────────────────────────────────────────────────────

export interface SimulationNode {
  role: 'app' | 'db' | 'core' | 'all';
  vcpu: number;
  ramGb: number;
  diskGb: number;
}

export interface SimulationInput {
  projects: number;
  /** 0..1 */
  awakeShare: number;
  rpsPerProject: number;
  dbConnectionsPerProject: number;
  dbGbPerProject: number;
  storageGbPerProject: number;
  sseClientsPerProject: number;
  apiReplicas: number;
  nodes?: SimulationNode[];
  brokerEnabled?: boolean;
  /** Override ceilings (e.g. a raised max_connections). */
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
  /** The project count at which this resource reaches its target, with the simulated profile. */
  saturatesAt: number | null;
}

export interface SimulationResult {
  input: SimulationInput;
  resources: SimulationResource[];
  firstSaturated: ResourceKey | null;
  fits: boolean;
  nextStep: string;
}

/** The ceilings a hypothetical set of nodes gives, in place of the measured host. */
function ceilingsFromNodes(base: ResourceCeiling[], nodes: SimulationNode[] | undefined, apiReplicas: number, baseReplicas: number): Map<ResourceKey, ResourceCeiling> {
  const out = new Map<ResourceKey, ResourceCeiling>();
  for (const c of base) out.set(c.key, { ...c });
  if (nodes && nodes.length) {
    const sum = (pick: (n: SimulationNode) => boolean, f: (n: SimulationNode) => number) =>
      nodes.filter(pick).reduce((a, n) => a + f(n), 0);
    const appish = (n: SimulationNode) => n.role === 'app' || n.role === 'all';
    const dbish = (n: SimulationNode) => n.role === 'db' || n.role === 'all';
    const cpu = out.get('host_cpu');
    if (cpu) cpu.ceiling = sum(appish, (n) => n.vcpu) || cpu.ceiling;
    const mem = out.get('host_memory');
    if (mem) mem.ceiling = sum(appish, (n) => n.ramGb * 1024) || mem.ceiling;
    const disk = out.get('disk');
    if (disk) disk.ceiling = sum(dbish, (n) => n.diskGb) || disk.ceiling;
  }
  const rps = out.get('api_rps');
  if (rps && baseReplicas > 0 && apiReplicas > 0 && apiReplicas !== baseReplicas) {
    rps.ceiling = (rps.ceiling / baseReplicas) * apiReplicas;
  }
  return out;
}

export function simulate(model: ModelInputs, sim: SimulationInput): SimulationResult {
  const profile: ProjectProfile = {
    ...model.profile,
    rps: sim.rpsPerProject,
    dbConnections: sim.dbConnectionsPerProject,
    dbGb: sim.dbGbPerProject,
    storageGb: sim.storageGbPerProject,
    sseClients: sim.sseClientsPerProject,
  };
  const awakeShare = Math.min(1, Math.max(0, sim.awakeShare));
  const ceilings = ceilingsFromNodes(model.ceilings, sim.nodes, sim.apiReplicas, model.apiReplicas);
  for (const [key, value] of Object.entries(sim.ceilings ?? {})) {
    const c = ceilings.get(key as ResourceKey);
    if (c && typeof value === 'number' && value > 0) c.ceiling = value;
  }
  // Today's overheads (baseline) carry over: they do not scale with projects.
  const today = computeModel(model);
  const baselines = new Map(today.perResource.map((r) => [r.key, r.baseline]));

  const resources: SimulationResource[] = [];
  for (const c of ceilings.values()) {
    const baseline = baselines.get(c.key) ?? 0;
    const usage = usageFor(c.key, baseline, profile, sim.projects, awakeShare);
    const saturatesAt = maxProjectsFor(c.key, baseline, profile, c.ceiling, c.target, awakeShare);
    resources.push({
      key: c.key,
      label: RESOURCE_LABELS[c.key],
      unit: RESOURCE_UNITS[c.key],
      ceiling: c.ceiling,
      target: c.target,
      usage: Math.round(usage * 100) / 100,
      utilization: c.ceiling > 0 ? Math.round((usage / c.ceiling) * 1000) / 1000 : 0,
      saturatesAt,
    });
  }
  const over = resources.filter((r) => r.ceiling > 0 && r.usage > r.ceiling * r.target);
  const first = resources
    .filter((r) => r.saturatesAt !== null)
    .sort((a, b) => (a.saturatesAt as number) - (b.saturatesAt as number))[0];
  const firstSaturated = over.length ? over.sort((a, b) => b.utilization - a.utilization)[0].key : first?.key ?? null;
  return {
    input: sim,
    resources,
    firstSaturated,
    fits: over.length === 0,
    nextStep: nextStepFor(firstSaturated, resources, sim),
  };
}

/** The smallest change that lifts the first bottleneck, in plain words. */
export function nextStepFor(key: ResourceKey | null, resources: SimulationResource[], sim: SimulationInput): string {
  if (!key) return 'No resource saturates at these inputs.';
  const r = resources.find((x) => x.key === key);
  const at = r?.saturatesAt !== null && r?.saturatesAt !== undefined ? ` (at ~${r.saturatesAt} projects)` : '';
  switch (key) {
    case 'pg_connections':
      return `Postgres connections saturate first${at}: pool dashboard reads through the pooler, lower the per-project pool size, then raise max_connections on a database node with more memory.`;
    case 'pgbouncer_clients':
      return `Pooler client connections saturate first${at}: raise max_client_conn (it is a limit, not memory) and keep min_pool_size at 0 for idle projects.`;
    case 'host_cpu':
      return `Host CPU saturates first${at}: add an API replica on a second node (${sim.apiReplicas + 1} replicas) behind the load balancer.`;
    case 'host_memory':
      return `Host memory saturates first${at}: move Postgres to its own node, or add RAM; each awake project holds pool and backend memory.`;
    case 'disk':
      return `Disk saturates first${at}: grow the volume (online) and keep the storage autopilot armed; asleep projects still hold their data.`;
    case 'redis_memory':
      return `Redis memory saturates first${at}: raise maxmemory or move rate-limit keys to the durable instance.`;
    case 'api_rps':
      return `API throughput saturates first${at}: add an API replica (${sim.apiReplicas + 1}) or raise the measured per-replica ceiling with a benchmark.`;
  }
}

export function recommendations(snapshot: CapacityModelSnapshot): string[] {
  const out: string[] = [];
  if (snapshot.bottleneck) {
    const r = snapshot.perResource.find((x) => x.key === snapshot.bottleneck);
    if (r) {
      out.push(
        `${r.label} gives out first: ${r.current.toFixed(0)} of ${r.ceiling.toFixed(0)} ${r.unit} used (${Math.round(r.utilization * 100)} %), ` +
          `room for about ${snapshot.headroomProjects ?? '?'} more projects at today's awake share.`,
      );
    }
  }
  if (snapshot.maxProjectsAllAwake !== null && snapshot.maxProjectsAllAwake < snapshot.currentProjects) {
    const r = snapshot.perResource.find((x) => x.key === snapshot.bottleneckAllAwake);
    out.push(
      `If every project woke at once, ${r?.label ?? 'a resource'} would be over its target: capacity falls to ${snapshot.maxProjectsAllAwake} projects. ` +
        `Idle deactivation is what keeps today's ${snapshot.currentProjects} affordable; keep the sweep on and PgBouncer min_pool_size at 0.`,
    );
  }
  for (const r of snapshot.perResource) {
    if (r.utilization >= r.target) out.push(`${r.label} is above its target now (${Math.round(r.utilization * 100)} % of ${r.ceiling.toFixed(0)} ${r.unit}).`);
  }
  if (snapshot.confidence < 0.5) {
    out.push('Half or more of the ceilings are placeholders: run the sampler for a day and a benchmark before planning from these numbers.');
  }
  if (out.length === 0) out.push('Every resource is under its target with room to grow; revisit after the next benchmark.');
  return out;
}

/** The six presets the console offers. */
export function presets(today: CapacityModelSnapshot, profile: ProjectProfile, apiReplicas: number): Record<string, SimulationInput> {
  const base: Omit<SimulationInput, 'projects' | 'awakeShare'> = {
    rpsPerProject: profile.rps,
    dbConnectionsPerProject: profile.dbConnections,
    dbGbPerProject: profile.dbGb,
    storageGbPerProject: profile.storageGb,
    sseClientsPerProject: profile.sseClients,
    apiReplicas,
  };
  const share = today.awakeShare || 0.25;
  return {
    today: { ...base, projects: today.currentProjects, awakeShare: share },
    everyone_awake: { ...base, projects: today.currentProjects, awakeShare: 1 },
    customers_100: { ...base, projects: 100 * 3, awakeShare: share },
    customers_500: { ...base, projects: 500 * 3, awakeShare: share },
    customers_1000: { ...base, projects: 1000 * 3, awakeShare: share },
    customers_5000: { ...base, projects: 5000 * 3, awakeShare: share },
  };
}
