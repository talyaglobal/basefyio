import {
  CapacityModelSnapshot,
  DEFAULT_TARGETS,
  ModelInputs,
  RESOURCE_KEYS,
  ResourceCeiling,
  computeModel,
  presets,
  recommendations,
  simulate,
} from './capacity-model';

function ceilings(overrides: Partial<Record<string, number>> = {}): ResourceCeiling[] {
  const base: Record<string, number> = {
    pg_connections: 200,
    pgbouncer_clients: 1000,
    host_cpu: 4,
    host_memory: 7600,
    disk: 608,
    redis_memory: 256,
    api_rps: 150,
    ...overrides,
  };
  return RESOURCE_KEYS.map((key) => ({ key, ceiling: base[key], target: DEFAULT_TARGETS[key], measured: true }));
}

/** Roughly production on 2026-10-26: 64 awake, 207 asleep, 135 backends, 85 pooler entries. */
const today: ModelInputs = {
  ceilings: ceilings(),
  profile: {
    rps: 0.02,
    dbConnections: 1.8,
    poolerClients: 1.2,
    dbGb: 0.15,
    storageGb: 0.7,
    sseClients: 0.1,
    memoryMb: 12,
    coresPerRps: 0.01,
    redisMb: 0.05,
  },
  current: {
    awakeProjects: 64,
    asleepProjects: 207,
    organizations: 69,
    payingOrganizations: 20,
    usage: { pg_connections: 135, pgbouncer_clients: 85, host_cpu: 0.6, host_memory: 4000, disk: 274, redis_memory: 8, api_rps: 0.7 },
  },
  apiReplicas: 1,
};

describe('computeModel', () => {
  it('finds the bottleneck and the headroom at today\'s awake share', () => {
    const m = computeModel(today);
    expect(m.currentProjects).toBe(271);
    expect(m.awakeShare).toBeCloseTo(0.236, 3);
    // pg_connections: baseline 135 - 64*1.8 = 19.8; room = 140 - 19.8 = 120.2; per project 0.236*1.8 = 0.425 → 282
    const pg = m.perResource.find((r) => r.key === 'pg_connections')!;
    expect(pg.baseline).toBeCloseTo(19.8, 1);
    expect(pg.maxProjects).toBe(282);
    expect(m.bottleneck).toBe('pg_connections');
    expect(m.maxProjects).toBe(282);
    expect(m.headroomProjects).toBe(11);
    expect(m.confidence).toBe(1);
  });

  it('everyone awake: capacity drops below today\'s project count and connections are the bottleneck', () => {
    const m = computeModel(today);
    const pg = m.perResource.find((r) => r.key === 'pg_connections')!;
    // room 120.2 / 1.8 = 66
    expect(pg.maxProjectsAllAwake).toBe(66);
    expect(m.bottleneckAllAwake).toBe('pg_connections');
    expect(m.maxProjectsAllAwake).toBe(66);
    expect(m.maxProjectsAllAwake).toBeLessThan(m.currentProjects);
  });

  it('derives organizations from projects per paying organization', () => {
    const m = computeModel(today);
    // 271 / 20 = 13.55 projects per paying org → 282 / 13.55 = 20
    expect(m.maxOrganizations).toBe(20);
  });

  it('confidence counts measured ceilings only', () => {
    const half = { ...today, ceilings: today.ceilings.map((c, i) => ({ ...c, measured: i % 2 === 0 })) };
    expect(computeModel(half).confidence).toBeCloseTo(4 / 7, 2);
  });
});

describe('simulate', () => {
  const sim = (projects: number, awakeShare: number, extra: Partial<Parameters<typeof simulate>[1]> = {}) =>
    simulate(today, {
      projects,
      awakeShare,
      rpsPerProject: 0.02,
      dbConnectionsPerProject: 1.8,
      dbGbPerProject: 0.15,
      storageGbPerProject: 0.7,
      sseClientsPerProject: 0.1,
      apiReplicas: 1,
      ...extra,
    });

  it('reproduces today within a few percent', () => {
    const r = sim(271, 64 / 271);
    const pg = r.resources.find((x) => x.key === 'pg_connections')!;
    expect(Math.abs(pg.usage - 135) / 135).toBeLessThan(0.05);
    expect(r.fits).toBe(true);
  });

  it('is monotonic: more projects never lower any utilization', () => {
    const a = sim(300, 0.3);
    const b = sim(600, 0.3);
    for (const key of RESOURCE_KEYS) {
      const ua = a.resources.find((x) => x.key === key)!.utilization;
      const ub = b.resources.find((x) => x.key === key)!.utilization;
      expect(ub).toBeGreaterThanOrEqual(ua);
    }
  });

  it('everyone awake saturates the connection ceiling first', () => {
    const r = sim(271, 1);
    expect(r.fits).toBe(false);
    expect(r.firstSaturated).toBe('pg_connections');
    expect(r.nextStep).toMatch(/Postgres connections saturate first/);
  });

  it('a raised ceiling or more replicas changes the answer', () => {
    const raised = sim(271, 1, { ceilings: { pg_connections: 800 } });
    expect(raised.resources.find((x) => x.key === 'pg_connections')!.utilization).toBeLessThan(0.7);
    const two = sim(5000, 0.3, { apiReplicas: 2 });
    const one = sim(5000, 0.3, { apiReplicas: 1 });
    expect(two.resources.find((x) => x.key === 'api_rps')!.ceiling).toBe(2 * one.resources.find((x) => x.key === 'api_rps')!.ceiling);
  });

  it('nodes replace the host ceilings', () => {
    const r = sim(1000, 0.3, { nodes: [{ role: 'app', vcpu: 8, ramGb: 16, diskGb: 100 }, { role: 'db', vcpu: 8, ramGb: 32, diskGb: 1000 }] });
    expect(r.resources.find((x) => x.key === 'host_cpu')!.ceiling).toBe(8);
    expect(r.resources.find((x) => x.key === 'host_memory')!.ceiling).toBe(16 * 1024);
    expect(r.resources.find((x) => x.key === 'disk')!.ceiling).toBe(1000);
  });
});

describe('recommendations and presets', () => {
  it('speak about the bottleneck and the all-awake risk', () => {
    const m: CapacityModelSnapshot = computeModel(today);
    const text = recommendations(m).join('\n');
    expect(text).toMatch(/Postgres connections gives out first/);
    expect(text).toMatch(/If every project woke at once/);
  });

  it('presets start from today', () => {
    const p = presets(computeModel(today), today.profile, 1);
    expect(p.today.projects).toBe(271);
    expect(p.everyone_awake.awakeShare).toBe(1);
    expect(p.customers_1000.projects).toBe(3000);
  });
});
