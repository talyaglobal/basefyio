import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import * as Docker from 'dockerode';
import { readFile, statfs } from 'fs/promises';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { MetricsService } from '../health/metrics.service';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';
import { RealtimeFanoutService } from '../realtime-data/realtime-fanout.service';
import { ProjectSleepService } from '../projects/project-sleep.service';
import { HostReader } from './host-reader';
import type { CapacityMetrics } from './capacity.types';

export const SAMPLE_RETENTION_DAYS = 30;
const CONTAINER_PREFIX = 'kolaybase-';
const SLEEP_PREVIEW_TTL_MS = 10 * 60_000;

export function isSamplerEnabled(): boolean {
  return (process.env.CAPACITY_SAMPLER_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * One row per minute with everything the platform can tell about its own
 * load, from inside the API container: the host's kernel counters, the
 * containers' cgroups, Postgres and the pooler, Redis, the request registry
 * and the tenancy counts. Every section is independent: a source that is
 * unreachable leaves a null, never a missing minute.
 */
@Injectable()
export class CapacitySamplerService {
  private readonly logger = new Logger(CapacitySamplerService.name);
  private readonly host = new HostReader();
  private running = false;
  private lastCounts: Map<string, number> | null = null;
  private lastCountsAt = 0;
  private lastXact: { commits: number; at: number } | null = null;
  private sleepPreview: { at: number; dueToSleep: number; warned: number } | null = null;
  private docker: Docker | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly leader: CronLeaderService,
    private readonly metrics: MetricsService,
    private readonly fanout: RealtimeFanoutService,
    private readonly sleep: ProjectSleepService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (!isSamplerEnabled() || !this.leader.isLeader() || this.running) return;
    this.running = true;
    const ts = new Date();
    try {
      const metrics = await this.sample();
      await this.prisma.capacitySample.create({
        data: { ts, instanceId: this.leader.getInstanceId(), metrics: metrics as unknown as Prisma.InputJsonValue },
      });
      if (ts.getUTCMinutes() === 2) await this.rollUpPreviousHour(ts);
      if (ts.getUTCHours() === 3 && ts.getUTCMinutes() === 7) await this.prune(ts);
    } catch (err: any) {
      this.logger.warn(`Capacity sample failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  async sample(): Promise<CapacityMetrics> {
    const [host, containers, disk, postgres, pgbouncer, redis, api, tenancy] = await Promise.all([
      this.host.read().catch(() => null),
      this.containerStats().catch(() => null),
      this.diskStats().catch(() => null),
      this.postgresStats().catch(() => null),
      this.pgbouncerStats().catch(() => null),
      this.redisStats().catch(() => null),
      this.apiStats().catch(() => null),
      this.tenancyStats().catch(() => null),
    ]);
    return { host, containers, disk, postgres, pgbouncer, redis, api, tenancy };
  }

  // ── Sources ──────────────────────────────────────────────────────────────

  private getDocker(): Docker {
    if (!this.docker) {
      const socketPath = this.config.get<string>('docker.socketPath') || '/var/run/docker.sock';
      this.docker = new Docker({ socketPath });
    }
    return this.docker;
  }

  private async containerStats(): Promise<CapacityMetrics['containers']> {
    const docker = this.getDocker();
    const list = await docker.listContainers({ filters: { name: [CONTAINER_PREFIX] } });
    const out: NonNullable<CapacityMetrics['containers']> = [];
    await Promise.all(
      list.map(async (c) => {
        const name = (c.Names?.[0] || c.Id).replace(/^\//, '');
        try {
          const s: any = await docker.getContainer(c.Id).stats({ stream: false });
          const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
          const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
          const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
          const cpuPct = sysDelta > 0 && cpuDelta >= 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : null;
          const usage = s.memory_stats?.usage ?? null;
          const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
          out.push({ name, cpuPct, memMb: usage !== null ? Math.round((usage - cache) / 1048576) : null });
        } catch {
          out.push({ name, cpuPct: null, memMb: null });
        }
      }),
    );
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async diskStats(): Promise<CapacityMetrics['disk']> {
    const dataPath = this.config.get<string>('disk.dataPath') || '/';
    let volumeBytes: number | null = null;
    let usedBytes: number | null = null;
    try {
      const st = await statfs(dataPath);
      const total = Number(st.blocks) * Number(st.bsize);
      const avail = Number(st.bavail) * Number(st.bsize);
      const free = Number(st.bfree) * Number(st.bsize);
      volumeBytes = total;
      usedBytes = total - free;
      // used share as the guard computes it: used / (used + available)
      const usedPct = total > 0 ? Math.round(((total - free) / (total - free + avail)) * 1000) / 10 : null;
      let growAtPct: number | null = null;
      let maxSizeGb: number | null = null;
      try {
        const dir = this.config.get<string>('disk.autopilotDir') || '/host/storage-autopilot';
        const raw = JSON.parse(await readFile(`${dir}/status.json`, 'utf8')) as { thresholds?: { growAtPercent?: number; maxSizeGb?: number } };
        growAtPct = raw.thresholds?.growAtPercent ?? null;
        maxSizeGb = raw.thresholds?.maxSizeGb ?? null;
      } catch {
        /* no autopilot on this host */
      }
      return { volumeBytes, usedBytes, usedPct, growAtPct, maxSizeGb };
    } catch {
      return null;
    }
  }

  private adminPgPool(): Pool {
    return new Pool({
      host: this.config.get<string>('database.host'),
      port: this.config.get<number>('database.port'),
      user: this.config.get<string>('database.user'),
      password: this.config.get<string>('database.password'),
      database: 'postgres',
      max: 1,
      connectionTimeoutMillis: 5000,
      query_timeout: 8000,
    });
  }

  private async postgresStats(): Promise<CapacityMetrics['postgres']> {
    const pool = this.adminPgPool();
    try {
      const [states, maxConn, totals, dbs] = await Promise.all([
        pool.query<{ state: string | null; n: string }>(
          `select coalesce(state, 'none') as state, count(*)::text as n from pg_stat_activity where backend_type = 'client backend' group by 1`,
        ),
        pool.query<{ max_connections: string }>('show max_connections'),
        pool.query<{ commits: string; hit: string; read: string; deadlocks: string }>(
          `select coalesce(sum(xact_commit),0)::text as commits, coalesce(sum(blks_hit),0)::text as hit, coalesce(sum(blks_read),0)::text as read, coalesce(sum(deadlocks),0)::text as deadlocks from pg_stat_database`,
        ),
        pool.query<{ n: string }>(`select count(*)::text as n from pg_database where not datistemplate`),
      ]);
      const byState: Record<string, number> = {};
      let connections = 0;
      for (const r of states.rows) {
        byState[r.state ?? 'none'] = Number(r.n);
        connections += Number(r.n);
      }
      const commits = Number(totals.rows[0]?.commits ?? 0);
      const now = Date.now();
      let xactCommitPerMin: number | null = null;
      if (this.lastXact && now > this.lastXact.at) {
        xactCommitPerMin = Math.round(((commits - this.lastXact.commits) / ((now - this.lastXact.at) / 60_000)) * 10) / 10;
      }
      this.lastXact = { commits, at: now };
      const hit = Number(totals.rows[0]?.hit ?? 0);
      const read = Number(totals.rows[0]?.read ?? 0);
      return {
        connections,
        maxConnections: Number(maxConn.rows[0]?.max_connections ?? 0),
        byState,
        xactCommitPerMin,
        cacheHitPct: hit + read > 0 ? Math.round((hit / (hit + read)) * 1000) / 10 : null,
        deadlocks: Number(totals.rows[0]?.deadlocks ?? 0),
        databases: Number(dbs.rows[0]?.n ?? 0),
      };
    } finally {
      await pool.end().catch(() => {});
    }
  }

  private async pgbouncerStats(): Promise<CapacityMetrics['pgbouncer']> {
    const password = process.env.PGBOUNCER_ADMIN_PASSWORD;
    if (!password) return null;
    const pool = new Pool({
      host: this.config.get<string>('pgbouncer.host') || 'pgbouncer',
      port: this.config.get<number>('pgbouncer.port') || 6432,
      database: 'pgbouncer',
      user: 'pgbouncer_admin',
      password,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      const client = await pool.connect();
      try {
        const res = await client.query('SHOW POOLS');
        let clientConns = 0;
        let serverConns = 0;
        for (const r of res.rows as Array<Record<string, string | number>>) {
          clientConns += Number(r.cl_active ?? 0) + Number(r.cl_waiting ?? 0);
          serverConns += Number(r.sv_active ?? 0) + Number(r.sv_idle ?? 0) + Number(r.sv_used ?? 0);
        }
        return {
          pools: res.rows.length,
          clientConns,
          serverConns,
          maxClientConn: this.config.get<number>('pgbouncer.maxClientConn') ?? null,
          defaultPoolSize: this.config.get<number>('pgbouncer.defaultPoolSize') ?? null,
        };
      } finally {
        client.release();
      }
    } finally {
      await pool.end().catch(() => {});
    }
  }

  private async redisStats(): Promise<CapacityMetrics['redis']> {
    const client = this.redis.getClient();
    const [memory, stats, keys] = await Promise.all([client.info('memory'), client.info('stats'), client.dbsize()]);
    const grab = (text: string, key: string): number | null => {
      const m = text.match(new RegExp(`^${key}:(\\d+(?:\\.\\d+)?)`, 'm'));
      return m ? Number(m[1]) : null;
    };
    const used = grab(memory, 'used_memory') ?? 0;
    const max = grab(memory, 'maxmemory');
    return {
      usedMb: Math.round(used / 1048576),
      maxMb: max && max > 0 ? Math.round(max / 1048576) : null,
      keys,
      evictedKeys: grab(stats, 'evicted_keys') ?? 0,
      opsPerSec: grab(stats, 'instantaneous_ops_per_sec'),
    };
  }

  private async apiStats(): Promise<CapacityMetrics['api']> {
    const counts = this.metrics.routeStatusCounts();
    const now = Date.now();
    const current = new Map<string, number>();
    let total = 0;
    let errors = 0;
    for (const c of counts) {
      current.set(`${c.routeClass}|${c.statusClass}`, c.count);
      if (this.lastCounts) {
        const delta = Math.max(0, c.count - (this.lastCounts.get(`${c.routeClass}|${c.statusClass}`) ?? 0));
        total += delta;
        if (c.statusClass === '5xx') errors += delta;
      }
    }
    const seconds = this.lastCounts ? (now - this.lastCountsAt) / 1000 : 0;
    this.lastCounts = current;
    this.lastCountsAt = now;
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const window = await this.prisma.platformSloWindow.findUnique({ where: { day_probe: { day: today, probe: 'api' } } }).catch(() => null);
    return {
      inflight: this.metrics.currentInflight(),
      rpsRecent: seconds > 0 ? Math.round((total / seconds) * 1000) / 1000 : null,
      p95Ms: window?.p95LatencyMs ?? null,
      errorPct: total > 0 ? Math.round((errors / total) * 10_000) / 100 : null,
      sseConnections: RealtimeStreamService.localConnectionCount() + this.fanout.localSubscriberTotal(),
      bullmq: {},
    };
  }

  private async tenancyStats(): Promise<CapacityMetrics['tenancy']> {
    const [organizations, paying, byStatus, nosql, usage] = await Promise.all([
      this.prisma.team.count(),
      this.prisma.subscription.count({
        where: { status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] as any }, plan: { priceMonthly: { gt: 0 } } },
      }),
      this.prisma.project.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.project.count({ where: { databaseType: 'NOSQL', status: { not: 'DELETED' } } }),
      this.prisma.teamUsage.aggregate({ _sum: { apiRequestsMonth: true } }),
    ]);
    const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    const awake = count('ACTIVE');
    const asleep = count('PAUSED') + count('DEACTIVATED');
    if (!this.sleepPreview || Date.now() - this.sleepPreview.at > SLEEP_PREVIEW_TTL_MS) {
      try {
        const p = await this.sleep.preview();
        this.sleepPreview = { at: Date.now(), dueToSleep: p.wouldSleep.length, warned: p.wouldWarn.length };
      } catch {
        this.sleepPreview = { at: Date.now(), dueToSleep: this.sleepPreview?.dueToSleep ?? 0, warned: this.sleepPreview?.warned ?? 0 };
      }
    }
    return {
      organizations,
      payingOrganizations: paying,
      projects: { awake, asleep, nosql, total: awake + asleep },
      dueToSleep: this.sleepPreview?.dueToSleep ?? null,
      warned: this.sleepPreview?.warned ?? null,
      apiRequestsMonth: usage._sum.apiRequestsMonth ?? null,
    };
  }

  // ── Roll-ups and retention ───────────────────────────────────────────────

  /** Means of every numeric leaf over the previous hour, kept for good. */
  async rollUpPreviousHour(now: Date): Promise<void> {
    const hour = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() - 1));
    const end = new Date(hour.getTime() + 3_600_000);
    const rows = await this.prisma.capacitySample.findMany({ where: { ts: { gte: hour, lt: end } }, select: { metrics: true } });
    if (rows.length === 0) return;
    const sums = new Map<string, { total: number; n: number }>();
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const s = sums.get(path) ?? { total: 0, n: 0 };
        s.total += value;
        s.n += 1;
        sums.set(path, s);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    for (const r of rows) walk(r.metrics, '');
    const metrics: Record<string, number> = { samples: rows.length };
    for (const [k, s] of sums) metrics[k] = Math.round((s.total / s.n) * 1000) / 1000;
    await this.prisma.capacityRollup.upsert({
      where: { hour },
      create: { hour, metrics },
      update: { metrics },
    });
  }

  async prune(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 86_400_000);
    const r = await this.prisma.capacitySample.deleteMany({ where: { ts: { lt: cutoff } } });
    if (r.count > 0) this.logger.log(`Pruned ${r.count} capacity samples older than ${SAMPLE_RETENTION_DAYS} days`);
  }
}
