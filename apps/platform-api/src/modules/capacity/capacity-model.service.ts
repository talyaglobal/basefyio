import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { PlatformAlertsService } from '../platform-alerts/platform-alerts.service';
import {
  CapacityModelSnapshot,
  DEFAULT_TARGETS,
  ModelInputs,
  ProjectProfile,
  RESOURCE_KEYS,
  ResourceCeiling,
  ResourceKey,
  SimulationInput,
  SimulationResult,
  computeModel,
  presets,
  recommendations,
  simulate,
} from './capacity-model';
import type { CapacityMetrics, CapacityOverview } from './capacity.types';
import { CapacitySamplerService, isSamplerEnabled } from './capacity-sampler.service';

const SCENARIOS_KEY = 'capacity.scenarios';
const FRESH_MS = 3 * 60_000;
const SEED_HOURS = 24;
/** Until a benchmark says otherwise: a conservative per-replica throughput. */
const PLACEHOLDER_RPS_PER_REPLICA = 150;

/** The last manual survey, used until the sampler has data (labelled as such). */
const SEED: CapacityMetrics = {
  host: { cpuPct: 15, cores: 4, memTotalMb: 7782, memUsedMb: 4096, memAvailableMb: 3686, load1: 0.6, load5: 0.6, load15: 0.6, source: 'container' },
  containers: null,
  disk: { volumeBytes: 608 * 1024 ** 3, usedBytes: 274 * 1024 ** 3, usedPct: 45, growAtPct: 80, maxSizeGb: 1000 },
  postgres: { connections: 135, maxConnections: 200, byState: { idle: 130, active: 5 }, xactCommitPerMin: null, cacheHitPct: null, deadlocks: null, databases: 279 },
  pgbouncer: { pools: 85, clientConns: 40, serverConns: 115, maxClientConn: 1000, defaultPoolSize: 20 },
  redis: { usedMb: 8, maxMb: 256, keys: 5000, evictedKeys: 0, opsPerSec: null },
  api: { inflight: 1, rpsRecent: 0.7, p95Ms: 80, errorPct: 0, sseConnections: 2, bullmq: {} },
  tenancy: { organizations: 69, payingOrganizations: 20, projects: { awake: 64, asleep: 207, nosql: 2, total: 271 }, dueToSleep: null, warned: null, apiRequestsMonth: 1_637_307 },
};

/** Per-project costs used until 24 h of samples exist, then refined from the samples. */
const SEED_PROFILE: ProjectProfile = {
  rps: 0.012,
  dbConnections: 1.8,
  poolerClients: 0.6,
  dbGb: 0.15,
  storageGb: 0.7,
  sseClients: 0.05,
  memoryMb: 12,
  coresPerRps: 0.01,
  redisMb: 0.05,
};

@Injectable()
export class CapacityModelService {
  private readonly logger = new Logger(CapacityModelService.name);
  private cached: { at: number; overview: CapacityOverview } | null = null;
  private aboveTargetSince = new Map<ResourceKey, number>();
  private lastEvicted: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: CronLeaderService,
    private readonly alerts: PlatformAlertsService,
    private readonly sampler: CapacitySamplerService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async recompute(): Promise<void> {
    if (!isSamplerEnabled() || !this.leader.isLeader()) return;
    try {
      const overview = await this.build(true);
      this.cached = { at: Date.now(), overview };
      const now = new Date();
      if (overview.model && now.getUTCMinutes() < 5) {
        await this.prisma.capacityModelSnapshot.create({ data: { ts: now, snapshot: overview.model as unknown as Prisma.InputJsonValue } });
      }
      await this.raiseAlerts(overview);
    } catch (err: any) {
      this.logger.warn(`Capacity model failed: ${err?.message ?? err}`);
    }
  }

  async overview(): Promise<CapacityOverview> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.overview;
    const overview = await this.build(false);
    this.cached = { at: Date.now(), overview };
    return overview;
  }

  // ── Building the picture ─────────────────────────────────────────────────

  private async latestSample(): Promise<{ ts: Date; metrics: CapacityMetrics } | null> {
    const row = await this.prisma.capacitySample.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true, metrics: true } });
    return row ? { ts: row.ts, metrics: row.metrics as unknown as CapacityMetrics } : null;
  }

  private async sampleCount24h(now: Date): Promise<number> {
    return this.prisma.capacitySample.count({ where: { ts: { gte: new Date(now.getTime() - SEED_HOURS * 3_600_000) } } });
  }

  private async benchmarkCeiling(): Promise<{ rpsPerReplica: number; measured: boolean; latest: CapacityOverview['benchmark']['latest'] }> {
    const runs = await this.prisma.capacityBenchmarkRun.findMany({ where: { status: 'DONE' }, orderBy: { startedAt: 'desc' }, take: 20 });
    const latestRow = runs[0];
    const latest = latestRow
      ? {
          scenario: latestRow.scenario,
          finishedAt: latestRow.finishedAt ? latestRow.finishedAt.toISOString() : null,
          rps: Number((latestRow.result as any)?.rps ?? null) || null,
          p95: Number((latestRow.result as any)?.p95 ?? null) || null,
        }
      : null;
    const green = runs.find((r) => ['rest-read', 'mixed-tenant'].includes(r.scenario) && Number((r.result as any)?.p95 ?? 1e9) < 300 && Number((r.result as any)?.rps ?? 0) > 0);
    if (green) return { rpsPerReplica: Number((green.result as any).rps), measured: true, latest };
    return { rpsPerReplica: PLACEHOLDER_RPS_PER_REPLICA, measured: false, latest };
  }

  /** Per-project profile from the last 24 h of samples; the seed until there are enough. */
  private async profileFrom(now: Date, latest: CapacityMetrics, enoughSamples: boolean): Promise<ProjectProfile> {
    if (!enoughSamples) return SEED_PROFILE;
    const rows = await this.prisma.capacitySample.findMany({
      where: { ts: { gte: new Date(now.getTime() - SEED_HOURS * 3_600_000) } },
      select: { metrics: true },
    });
    const vals = { rps: [] as number[], conn: [] as number[], clients: [] as number[], sse: [] as number[], cores: [] as number[] };
    for (const r of rows) {
      const m = r.metrics as unknown as CapacityMetrics;
      const awake = m.tenancy?.projects.awake ?? 0;
      if (awake <= 0) continue;
      if (typeof m.api?.rpsRecent === 'number') vals.rps.push(m.api.rpsRecent / awake);
      if (m.pgbouncer) {
        vals.conn.push(m.pgbouncer.serverConns / awake);
        vals.clients.push(m.pgbouncer.clientConns / awake);
      } else if (m.postgres) {
        vals.conn.push(Math.max(0, m.postgres.connections - 20) / awake);
      }
      if (m.api) vals.sse.push(m.api.sseConnections / awake);
      if (m.host?.cpuPct !== null && m.host && typeof m.api?.rpsRecent === 'number' && m.api.rpsRecent > 0) {
        vals.cores.push(((m.host.cpuPct / 100) * m.host.cores) / m.api.rpsRecent);
      }
    }
    const mean = (xs: number[], fallback: number) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback);
    const [dbBytes, storageBytes, projects] = await Promise.all([
      this.prisma.projectUsage.aggregate({ _sum: { dbSizeBytes: true } }),
      this.prisma.projectUsage.aggregate({ _sum: { storageBytes: true } }),
      this.prisma.project.count({ where: { status: { not: 'DELETED' } } }),
    ]);
    const total = Math.max(1, projects);
    return {
      rps: Math.max(0.001, mean(vals.rps, SEED_PROFILE.rps)),
      dbConnections: Math.max(0.1, mean(vals.conn, SEED_PROFILE.dbConnections)),
      poolerClients: Math.max(0.05, mean(vals.clients, SEED_PROFILE.poolerClients)),
      dbGb: Number(dbBytes._sum.dbSizeBytes ?? 0) / 1024 ** 3 / total || SEED_PROFILE.dbGb,
      storageGb: Number(storageBytes._sum.storageBytes ?? 0) / 1024 ** 3 / total || SEED_PROFILE.storageGb,
      sseClients: Math.max(0.01, mean(vals.sse, SEED_PROFILE.sseClients)),
      memoryMb: SEED_PROFILE.memoryMb,
      coresPerRps: Math.min(1, Math.max(0.001, mean(vals.cores, SEED_PROFILE.coresPerRps))),
      redisMb: latest.redis && latest.tenancy ? Math.max(0.01, latest.redis.usedMb / Math.max(1, latest.tenancy.projects.awake)) : SEED_PROFILE.redisMb,
    };
  }

  private ceilingsFrom(m: CapacityMetrics, rpsPerReplica: number, rpsMeasured: boolean, apiReplicas: number, seed: boolean): ResourceCeiling[] {
    const measured = !seed;
    const c = (key: ResourceKey, ceiling: number, isMeasured: boolean): ResourceCeiling => ({ key, ceiling, target: DEFAULT_TARGETS[key], measured: isMeasured });
    return [
      c('pg_connections', m.postgres?.maxConnections || 200, measured && !!m.postgres),
      c('pgbouncer_clients', m.pgbouncer?.maxClientConn || 1000, measured && !!m.pgbouncer?.maxClientConn),
      c('host_cpu', m.host?.cores || 4, measured && m.host?.source === 'host'),
      c('host_memory', m.host?.memTotalMb || 7782, measured && m.host?.source === 'host'),
      c('disk', m.disk?.volumeBytes ? m.disk.volumeBytes / 1024 ** 3 : 608, measured && !!m.disk?.volumeBytes),
      c('redis_memory', m.redis?.maxMb || 256, measured && !!m.redis?.maxMb),
      c('api_rps', rpsPerReplica * Math.max(1, apiReplicas), rpsMeasured),
    ];
  }

  private usageFrom(m: CapacityMetrics): Record<ResourceKey, number> {
    return {
      pg_connections: m.postgres?.connections ?? 0,
      pgbouncer_clients: m.pgbouncer?.clientConns ?? 0,
      host_cpu: m.host && m.host.cpuPct !== null ? (m.host.cpuPct / 100) * m.host.cores : 0,
      host_memory: m.host?.memUsedMb ?? 0,
      disk: m.disk?.usedBytes ? m.disk.usedBytes / 1024 ** 3 : 0,
      redis_memory: m.redis?.usedMb ?? 0,
      api_rps: m.api?.rpsRecent ?? 0,
    };
  }

  private async modelInputs(now: Date): Promise<{ inputs: ModelInputs; metrics: CapacityMetrics; sampledAt: Date | null; seed: boolean; fresh: boolean; bench: Awaited<ReturnType<CapacityModelService['benchmarkCeiling']>> }> {
    const latest = await this.latestSample();
    const count = await this.sampleCount24h(now);
    const seed = !latest;
    const metrics = latest?.metrics ?? SEED;
    const enough = count >= 60 * 12; // half a day of minutes
    const bench = await this.benchmarkCeiling();
    const apiReplicas = Math.max(1, Number(process.env.API_REPLICAS || 1));
    const profile = await this.profileFrom(now, metrics, enough);
    const t = metrics.tenancy ?? SEED.tenancy!;
    const inputs: ModelInputs = {
      ceilings: this.ceilingsFrom(metrics, bench.rpsPerReplica, bench.measured, apiReplicas, seed),
      profile,
      current: {
        awakeProjects: t.projects.awake,
        asleepProjects: t.projects.asleep,
        organizations: t.organizations,
        payingOrganizations: t.payingOrganizations,
        usage: this.usageFrom(metrics),
      },
      apiReplicas,
    };
    return { inputs, metrics, sampledAt: latest?.ts ?? null, seed: seed || !enough, fresh: !!latest && now.getTime() - latest.ts.getTime() < FRESH_MS, bench };
  }

  private async sparklines(now: Date): Promise<CapacityOverview['sparklines']> {
    const rows = await this.prisma.capacitySample.findMany({
      where: { ts: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
      orderBy: { ts: 'asc' },
      select: { ts: true, metrics: true },
    });
    const out: CapacityOverview['sparklines'] = {};
    for (const key of RESOURCE_KEYS) out[key] = [];
    let lastBucket = -1;
    for (const r of rows) {
      const bucket = Math.floor(r.ts.getTime() / 300_000);
      if (bucket === lastBucket) continue;
      lastBucket = bucket;
      const usage = this.usageFrom(r.metrics as unknown as CapacityMetrics);
      for (const key of RESOURCE_KEYS) out[key].push({ ts: r.ts.toISOString(), value: usage[key] });
    }
    return out;
  }

  private async build(forCron: boolean): Promise<CapacityOverview> {
    const now = new Date();
    const { inputs, metrics, sampledAt, seed, fresh, bench } = await this.modelInputs(now);
    const model = computeModel(inputs);
    const sparklines = forCron || this.cached === null ? await this.sparklines(now) : await this.sparklines(now);
    return {
      sampledAt: sampledAt ? sampledAt.toISOString() : null,
      fresh,
      enabled: isSamplerEnabled(),
      seedValues: seed,
      metrics,
      model,
      recommendations: recommendations(model),
      ceilings: inputs.ceilings,
      profile: inputs.profile,
      apiReplicas: inputs.apiReplicas,
      presets: presets(model, inputs.profile, inputs.apiReplicas),
      benchmark: { latest: bench.latest, rpsPerReplica: bench.rpsPerReplica, measured: bench.measured },
      sparklines,
    };
  }

  // ── Alerts ───────────────────────────────────────────────────────────────

  private async raiseAlerts(overview: CapacityOverview): Promise<void> {
    const m = overview.model;
    if (!m || overview.seedValues) return;
    if (m.headroomPct !== null && m.headroomPct < 15) {
      await this.alerts.raise({
        kind: 'capacity_headroom',
        severity: m.headroomPct < 5 ? 'critical' : 'warning',
        title: `Capacity headroom is ${m.headroomPct} %: about ${m.headroomProjects} more projects fit before ${m.bottleneck} saturates`,
        detail: overview.recommendations.join('\n'),
        metadata: { headroomPct: m.headroomPct, bottleneck: m.bottleneck },
      });
    }
    const now = Date.now();
    for (const r of m.perResource) {
      if (r.utilization >= r.target) {
        const since = this.aboveTargetSince.get(r.key) ?? now;
        this.aboveTargetSince.set(r.key, since);
        if (now - since >= 30 * 60_000) {
          await this.alerts.raise({
            kind: `capacity_${r.key}`,
            severity: 'warning',
            title: `${r.label} has been above its target for 30 minutes (${Math.round(r.utilization * 100)} % of ${r.ceiling.toFixed(0)} ${r.unit})`,
            metadata: { resource: r.key, utilization: r.utilization },
          });
        }
      } else {
        this.aboveTargetSince.delete(r.key);
      }
    }
    const evicted = overview.metrics?.redis?.evictedKeys ?? null;
    if (evicted !== null) {
      if (this.lastEvicted !== null && evicted > this.lastEvicted) {
        await this.alerts.raise({
          kind: 'capacity_redis_evictions',
          severity: 'warning',
          title: `Redis evicted ${evicted - this.lastEvicted} keys in the last 5 minutes: the cache is at its memory limit`,
          metadata: { evictedKeys: evicted },
        });
      }
      this.lastEvicted = evicted;
    }
  }

  // ── Views and actions ────────────────────────────────────────────────────

  async simulateNow(input: SimulationInput): Promise<SimulationResult> {
    const { inputs } = await this.modelInputs(new Date());
    const clean: SimulationInput = {
      projects: clamp(input.projects, 0, 1_000_000),
      awakeShare: clamp(input.awakeShare, 0, 1),
      rpsPerProject: clamp(input.rpsPerProject, 0, 10_000),
      dbConnectionsPerProject: clamp(input.dbConnectionsPerProject, 0, 1000),
      dbGbPerProject: clamp(input.dbGbPerProject, 0, 100_000),
      storageGbPerProject: clamp(input.storageGbPerProject, 0, 100_000),
      sseClientsPerProject: clamp(input.sseClientsPerProject, 0, 100_000),
      apiReplicas: clamp(input.apiReplicas, 1, 64),
      nodes: Array.isArray(input.nodes) ? input.nodes.slice(0, 16) : undefined,
      brokerEnabled: !!input.brokerEnabled,
      ceilings: input.ceilings,
    };
    return simulate(inputs, clean);
  }

  async history(days: number) {
    const since = new Date(Date.now() - clamp(days, 1, 365) * 86_400_000);
    const rows = await this.prisma.capacityModelSnapshot.findMany({ where: { ts: { gte: since } }, orderBy: { ts: 'asc' }, select: { ts: true, snapshot: true } });
    return rows.map((r) => {
      const s = r.snapshot as unknown as CapacityModelSnapshot;
      return {
        ts: r.ts.toISOString(),
        maxProjects: s.maxProjects,
        maxProjectsAllAwake: s.maxProjectsAllAwake,
        currentProjects: s.currentProjects,
        awakeProjects: s.awakeProjects,
        bottleneck: s.bottleneck,
      };
    });
  }

  async samples(from: Date, to: Date, stepMinutes: number) {
    const rows = await this.prisma.capacitySample.findMany({ where: { ts: { gte: from, lte: to } }, orderBy: { ts: 'asc' }, select: { ts: true, metrics: true } });
    const step = Math.max(1, stepMinutes);
    let last = -1;
    const out: Array<{ ts: string; metrics: CapacityMetrics }> = [];
    for (const r of rows) {
      const bucket = Math.floor(r.ts.getTime() / (step * 60_000));
      if (bucket === last) continue;
      last = bucket;
      out.push({ ts: r.ts.toISOString(), metrics: r.metrics as unknown as CapacityMetrics });
    }
    return out;
  }

  async scenarios(): Promise<Record<string, SimulationInput>> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: SCENARIOS_KEY } });
    return (row?.value as Record<string, SimulationInput> | null) ?? {};
  }

  async saveScenario(name: string, input: SimulationInput): Promise<void> {
    const key = name.trim().slice(0, 40);
    if (!key) throw new BadRequestException('A scenario needs a name');
    const current = await this.scenarios();
    const next = { ...current, [key]: input };
    const names = Object.keys(next);
    if (names.length > 20) delete next[names[0]];
    await this.prisma.systemSetting.upsert({
      where: { key: SCENARIOS_KEY },
      create: { key: SCENARIOS_KEY, value: next as unknown as Prisma.InputJsonValue },
      update: { value: next as unknown as Prisma.InputJsonValue },
    });
  }

  async benchmarks() {
    const rows = await this.prisma.capacityBenchmarkRun.findMany({ orderBy: { startedAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null }));
  }

  async recordBenchmark(body: {
    scenario?: string;
    target?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    startedAt?: string;
    finishedAt?: string;
    status?: 'DONE' | 'FAILED';
    triggeredBy?: string;
  }) {
    const scenario = String(body.scenario ?? '').trim().slice(0, 40);
    const target = String(body.target ?? 'dev').trim().slice(0, 40);
    if (!scenario) throw new BadRequestException('scenario is required');
    const row = await this.prisma.capacityBenchmarkRun.create({
      data: {
        scenario,
        target,
        status: body.status === 'FAILED' ? 'FAILED' : 'DONE',
        startedAt: body.startedAt ? new Date(body.startedAt) : new Date(),
        finishedAt: body.finishedAt ? new Date(body.finishedAt) : new Date(),
        params: (body.params ?? null) as Prisma.InputJsonValue,
        result: (body.result ?? null) as Prisma.InputJsonValue,
        triggeredBy: body.triggeredBy ? String(body.triggeredBy).slice(0, 80) : null,
      },
    });
    this.cached = null;
    return row;
  }

  /** The sampler's own view, for a manual "sample now" from the console when the cron is off. */
  async sampleNow(): Promise<CapacityMetrics> {
    return this.sampler.sample();
  }
}

function clamp(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
