import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ProjectsService } from '../projects/projects.service';
import { StorageService } from '../storage/storage.service';
import {
  API_LATENCY_P95_TARGET_MS,
  PROBES,
  ProbeName,
  SLO_TARGET_PCT,
  availabilityPct,
  burnRate,
  errorBudgetMinutes,
  errorRatePct,
  minuteVerdicts,
  minutesInMonth,
  summarise,
} from './slo';
import type { ComponentState, ComponentStatus, ConsoleStatus, DayFigure, IncidentView, PublicStatus } from './platform-status.types';

export const CANARY_SETTING_KEY = 'platform_status.canary';
const PUBLIC_CACHE_KEY = 'pstatus:public';
const PUBLIC_CACHE_SECONDS = 30;
const SAMPLE_RETENTION_DAYS = 90;

export const PROBE_LABELS: Record<ProbeName, string> = {
  api: 'API',
  dashboard: 'Dashboard',
  auth: 'Auth',
  database: 'Database endpoint',
  storage: 'Storage',
  realtime: 'Realtime',
};

export interface CanaryConfig {
  projectId: string;
  anonKey: string;
  storageProbeUrl: string | null;
  createdAt: string;
}

export interface SampleInput {
  probe: string;
  ok: boolean;
  ts?: string | Date;
  latencyMs?: number | null;
  statusCode?: number | null;
  detail?: string | null;
}

export interface IncidentInput {
  title?: string;
  status?: 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';
  impact?: 'NONE' | 'MINOR' | 'MAJOR' | 'CRITICAL';
  components?: string[];
  startedAt?: string;
  excludedFromSlo?: boolean;
  text?: string;
  postmortem?: string | null;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function platformDomain(): string {
  const direct = (process.env.PLATFORM_DOMAIN || process.env.DOMAIN || '').trim();
  if (direct) return direct;
  const app = (process.env.APP_URL || '').trim();
  try {
    const host = new URL(app).host;
    return host.replace(/^app\./, '');
  } catch {
    return 'basefyio.com';
  }
}

export function isPlatformStatusEnabled(): boolean {
  return (process.env.PLATFORM_STATUS_ENABLED || '').trim().toLowerCase() === 'true';
}

@Injectable()
export class PlatformStatusService {
  private readonly logger = new Logger(PlatformStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly projects: ProjectsService,
    private readonly storage: StorageService,
  ) {}

  // ── Samples ──────────────────────────────────────────────────────────────

  async recordSamples(vantage: string, samples: SampleInput[]): Promise<number> {
    const v = vantage.trim().slice(0, 40);
    if (!v) throw new BadRequestException('vantage is required');
    const rows: Prisma.PlatformProbeSampleCreateManyInput[] = [];
    for (const s of samples) {
      if (!(PROBES as readonly string[]).includes(s.probe)) continue;
      const ts = s.ts ? new Date(s.ts) : new Date();
      if (Number.isNaN(ts.getTime())) continue;
      rows.push({
        ts,
        probe: s.probe,
        vantage: v,
        ok: !!s.ok,
        latencyMs: typeof s.latencyMs === 'number' ? Math.round(s.latencyMs) : null,
        statusCode: typeof s.statusCode === 'number' ? s.statusCode : null,
        detail: s.detail ? String(s.detail).slice(0, 300) : null,
      });
    }
    if (rows.length === 0) return 0;
    await this.prisma.platformProbeSample.createMany({ data: rows });
    return rows.length;
  }

  async samplesSince(since: Date, probe?: ProbeName) {
    return this.prisma.platformProbeSample.findMany({
      where: { ts: { gte: since }, ...(probe ? { probe } : {}) },
      orderBy: { ts: 'asc' },
      select: { ts: true, probe: true, vantage: true, ok: true, latencyMs: true, statusCode: true, detail: true },
    });
  }

  // ── Roll-ups ─────────────────────────────────────────────────────────────

  /** Spans whose minutes do not count: announced maintenance, open or resolved. */
  private async excludedSpans(from: Date, to: Date): Promise<Array<{ from: number; to: number }>> {
    const rows = await this.prisma.platformIncident.findMany({
      where: { excludedFromSlo: true, startedAt: { lte: to }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }] },
      select: { startedAt: true, resolvedAt: true },
    });
    return rows.map((r) => ({ from: r.startedAt.getTime(), to: (r.resolvedAt ?? to).getTime() }));
  }

  /** Recompute today's and yesterday's windows (UTC) from the samples. */
  async rollUp(now = new Date(), errorRateToday?: number | null): Promise<void> {
    const today = dayStart(now);
    const yesterday = new Date(today.getTime() - 86_400_000);
    for (const day of [yesterday, today]) {
      const end = new Date(day.getTime() + 86_400_000);
      const samples = await this.prisma.platformProbeSample.findMany({
        where: { ts: { gte: day, lt: end } },
        select: { ts: true, probe: true, vantage: true, ok: true, latencyMs: true },
      });
      const spans = await this.excludedSpans(day, end);
      const counted = spans.length
        ? samples.filter((s) => !spans.some((sp) => s.ts.getTime() >= sp.from && s.ts.getTime() <= sp.to))
        : samples;
      for (const probe of PROBES) {
        const own = counted.filter((s) => s.probe === probe);
        if (own.length === 0) continue;
        const w = summarise(own);
        const isTodayApi = probe === 'api' && day.getTime() === today.getTime();
        await this.prisma.platformSloWindow.upsert({
          where: { day_probe: { day, probe } },
          create: {
            day,
            probe,
            totalMinutes: w.totalMinutes,
            downMinutes: w.downMinutes,
            p95LatencyMs: w.p95LatencyMs,
            errorRatePct: isTodayApi ? (errorRateToday ?? null) : undefined,
          },
          update: {
            totalMinutes: w.totalMinutes,
            downMinutes: w.downMinutes,
            p95LatencyMs: w.p95LatencyMs,
            ...(isTodayApi && errorRateToday !== undefined ? { errorRatePct: errorRateToday } : {}),
          },
        });
      }
    }
    await this.redis.del(PUBLIC_CACHE_KEY).catch(() => {});
  }

  async pruneSamples(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 86_400_000);
    const r = await this.prisma.platformProbeSample.deleteMany({ where: { ts: { lt: cutoff } } });
    return r.count;
  }

  // ── Views ────────────────────────────────────────────────────────────────

  async publicStatus(): Promise<PublicStatus> {
    try {
      const cached = await this.redis.get(PUBLIC_CACHE_KEY);
      if (cached) return JSON.parse(cached) as PublicStatus;
    } catch {
      /* cache miss or Redis down: compute */
    }
    const status = await this.buildPublic(new Date());
    await this.redis.set(PUBLIC_CACHE_KEY, JSON.stringify(status), PUBLIC_CACHE_SECONDS).catch(() => {});
    return status;
  }

  private toIncidentView(i: {
    id: string;
    title: string;
    status: string;
    impact: string;
    components: string[];
    startedAt: Date;
    resolvedAt: Date | null;
    updates: unknown;
    postmortem: string | null;
    excludedFromSlo: boolean;
    createdBy: string | null;
  }): IncidentView {
    return {
      id: i.id,
      title: i.title,
      status: i.status as IncidentView['status'],
      impact: i.impact as IncidentView['impact'],
      components: i.components,
      startedAt: i.startedAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      updates: Array.isArray(i.updates) ? (i.updates as IncidentView['updates']) : [],
      postmortem: i.postmortem,
      excludedFromSlo: i.excludedFromSlo,
      auto: i.createdBy === 'system',
    };
  }

  async buildPublic(now: Date): Promise<PublicStatus> {
    const since90 = new Date(dayStart(now).getTime() - 89 * 86_400_000);
    const [windows, recentSamples, incidents] = await Promise.all([
      this.prisma.platformSloWindow.findMany({ where: { day: { gte: since90 } } }),
      this.prisma.platformProbeSample.findMany({
        where: { ts: { gte: new Date(now.getTime() - 15 * 60_000) } },
        select: { ts: true, probe: true, vantage: true, ok: true, latencyMs: true },
        orderBy: { ts: 'asc' },
      }),
      this.prisma.platformIncident.findMany({
        where: { OR: [{ resolvedAt: null }, { resolvedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } }] },
        orderBy: { startedAt: 'desc' },
        take: 50,
      }),
    ]);

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const since30 = new Date(dayStart(now).getTime() - 29 * 86_400_000);
    const monthMinutes = minutesInMonth(now.getUTCFullYear(), now.getUTCMonth());
    const vantages = new Set<string>();
    let anyLive = false;

    const components: ComponentStatus[] = PROBES.map((probe) => {
      const own = windows.filter((w) => w.probe === probe);
      const sum = (rows: typeof own) =>
        rows.reduce((acc, w) => ({ total: acc.total + w.totalMinutes, down: acc.down + w.downMinutes }), { total: 0, down: 0 });
      const month = sum(own.filter((w) => w.day >= monthStart));
      const d30 = sum(own.filter((w) => w.day >= since30));
      const d90 = sum(own);
      const target = SLO_TARGET_PCT[probe];
      const budget = errorBudgetMinutes(target, monthMinutes);

      const days: DayFigure[] = [];
      for (let i = 89; i >= 0; i--) {
        const day = new Date(dayStart(now).getTime() - i * 86_400_000);
        const w = own.find((x) => x.day.getTime() === day.getTime());
        days.push({
          day: dayKey(day),
          availabilityPct: w ? availabilityPct(w.totalMinutes, w.downMinutes) : null,
          downMinutes: w?.downMinutes ?? 0,
          totalMinutes: w?.totalMinutes ?? 0,
        });
      }

      const mine = recentSamples.filter((s) => s.probe === probe);
      for (const s of mine) vantages.add(s.vantage);
      const last = mine[mine.length - 1];
      let state: ComponentState = 'unknown';
      if (last && now.getTime() - last.ts.getTime() <= 5 * 60_000) {
        anyLive = true;
        const verdicts = minuteVerdicts(mine);
        const latest = verdicts[verdicts.length - 1];
        if (latest?.down) state = 'down';
        else if (verdicts.some((v) => v.down)) state = 'degraded';
        else state = 'operational';
      }
      const okLatencies = mine.filter((s) => s.ok && typeof s.latencyMs === 'number').slice(-3);
      const latencyMs = okLatencies.length
        ? Math.round(okLatencies.reduce((a, s) => a + (s.latencyMs as number), 0) / okLatencies.length)
        : null;

      return {
        probe,
        label: PROBE_LABELS[probe],
        state,
        lastCheckedAt: last ? last.ts.toISOString() : null,
        latencyMs,
        targetPct: target,
        month: {
          availabilityPct: availabilityPct(month.total, month.down),
          downMinutes: month.down,
          observedMinutes: month.total,
          budgetMinutes: budget,
          remainingMinutes: Math.round((budget - month.down) * 100) / 100,
        },
        last30d: { availabilityPct: availabilityPct(d30.total, d30.down), downMinutes: d30.down },
        last90d: { availabilityPct: availabilityPct(d90.total, d90.down), downMinutes: d90.down },
        days,
      };
    });

    const views = incidents.map((i) => this.toIncidentView(i));
    const open = views.filter((i) => i.status !== 'RESOLVED' && !i.excludedFromSlo);
    const maintenance = views.filter((i) => i.excludedFromSlo && i.status !== 'RESOLVED');
    const recent = views.filter((i) => i.status === 'RESOLVED');
    const states = components.map((c) => c.state);
    const overall: ComponentState = states.includes('down')
      ? 'down'
      : states.includes('degraded')
        ? 'degraded'
        : states.every((s) => s === 'unknown')
          ? 'unknown'
          : 'operational';

    return {
      generatedAt: now.toISOString(),
      domain: platformDomain(),
      overall,
      components,
      incidents: { open, recent },
      maintenance,
      live: anyLive,
      vantages: Array.from(vantages).sort(),
    };
  }

  async consoleStatus(): Promise<ConsoleStatus> {
    const now = new Date();
    const pub = await this.buildPublic(now);
    const since24h = new Date(now.getTime() - 24 * 60 * 60_000);
    const [samples24h, todayApi, deploys, latest, events, canary] = await Promise.all([
      this.prisma.platformProbeSample.findMany({
        where: { ts: { gte: since24h } },
        select: { ts: true, probe: true, vantage: true, ok: true, latencyMs: true },
        orderBy: { ts: 'asc' },
      }),
      this.prisma.platformSloWindow.findUnique({ where: { day_probe: { day: dayStart(now), probe: 'api' } } }),
      this.prisma.platformDeployMarker.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
      this.prisma.platformProbeSample.findMany({ orderBy: { ts: 'desc' }, take: 60 }),
      this.prisma.platformAlert.findMany({
        orderBy: { occurredAt: 'desc' },
        take: 30,
        select: { id: true, source: true, kind: true, severity: true, title: true, occurredAt: true },
      }),
      this.canaryConfig(),
    ]);

    const burn = {} as ConsoleStatus['burn'];
    for (const probe of PROBES) {
      const verdicts = minuteVerdicts(samples24h.filter((s) => s.probe === probe));
      const downSince = (ms: number) => verdicts.filter((v) => v.down && v.minute >= now.getTime() - ms).length;
      const target = SLO_TARGET_PCT[probe];
      burn[probe] = {
        h1: burnRate(downSince(60 * 60_000), 1, target),
        h6: burnRate(downSince(6 * 60 * 60_000), 6, target),
        h24: burnRate(downSince(24 * 60 * 60_000), 24, target),
      };
    }

    return {
      ...pub,
      burn,
      apiLatencyP95Ms: todayApi?.p95LatencyMs ?? null,
      errorRatePct: todayApi?.errorRatePct ?? null,
      deploys: deploys.map((d) => ({ id: d.id, imageTag: d.imageTag, startedAt: d.startedAt.toISOString(), note: d.note })),
      probes: latest.map((p) => ({
        probe: p.probe as ProbeName,
        vantage: p.vantage,
        ts: p.ts.toISOString(),
        ok: p.ok,
        latencyMs: p.latencyMs,
        statusCode: p.statusCode,
        detail: p.detail,
      })),
      events: events.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })),
      enabled: isPlatformStatusEnabled(),
      tokenConfigured: !!(process.env.PLATFORM_STATUS_PROBE_TOKEN || '').trim(),
      canary: { projectId: canary?.projectId ?? null, configured: !!canary },
    };
  }

  /** The one line an organization's billing page shows: the month's availability of the covered indicators. */
  async availabilityForBilling(): Promise<{ monthAvailabilityPct: number | null; statusUrl: string; apiP95TargetMs: number }> {
    const pub = await this.publicStatus();
    const covered = pub.components.filter((c) => ['api', 'auth', 'database'].includes(c.probe));
    const values = covered.map((c) => c.month.availabilityPct).filter((v): v is number => v !== null);
    return {
      monthAvailabilityPct: values.length ? Math.min(...values) : null,
      statusUrl: `https://status.${platformDomain()}/`,
      apiP95TargetMs: API_LATENCY_P95_TARGET_MS,
    };
  }

  // ── Incidents ────────────────────────────────────────────────────────────

  async createIncident(input: IncidentInput, createdBy: string): Promise<IncidentView> {
    const title = (input.title ?? '').trim();
    if (title.length < 3 || title.length > 300) throw new BadRequestException('Title must be between 3 and 300 characters');
    const now = new Date();
    const status = input.status ?? 'INVESTIGATING';
    const updates = input.text ? [{ ts: now.toISOString(), status, text: input.text.trim().slice(0, 2000) }] : [];
    const row = await this.prisma.platformIncident.create({
      data: {
        title,
        status,
        impact: input.impact ?? (input.excludedFromSlo ? 'NONE' : 'MINOR'),
        components: (input.components ?? []).filter((c) => (PROBES as readonly string[]).includes(c)),
        startedAt: input.startedAt ? new Date(input.startedAt) : now,
        excludedFromSlo: !!input.excludedFromSlo,
        updates,
        createdBy,
        ...(status === 'RESOLVED' ? { resolvedAt: now } : {}),
      },
    });
    await this.redis.del(PUBLIC_CACHE_KEY).catch(() => {});
    return this.toIncidentView(row);
  }

  async updateIncident(id: string, input: IncidentInput, by: string): Promise<IncidentView> {
    const current = await this.prisma.platformIncident.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Incident not found');
    const now = new Date();
    const updates = Array.isArray(current.updates) ? [...(current.updates as unknown[])] : [];
    const nextStatus = input.status ?? current.status;
    if (input.text || (input.status && input.status !== current.status)) {
      updates.push({ ts: now.toISOString(), status: nextStatus, text: (input.text ?? '').trim().slice(0, 2000) });
    }
    const resolving = nextStatus === 'RESOLVED' && current.status !== 'RESOLVED';
    const row = await this.prisma.platformIncident.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim().slice(0, 300) } : {}),
        status: nextStatus,
        ...(input.impact !== undefined ? { impact: input.impact } : {}),
        ...(input.components !== undefined ? { components: input.components } : {}),
        ...(input.startedAt !== undefined ? { startedAt: new Date(input.startedAt) } : {}),
        ...(input.excludedFromSlo !== undefined ? { excludedFromSlo: input.excludedFromSlo } : {}),
        ...(input.postmortem !== undefined ? { postmortem: input.postmortem } : {}),
        ...(resolving ? { resolvedAt: now, autoKey: null } : {}),
        updates: updates as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Incident ${id} updated by ${by}: ${nextStatus}`);
    await this.redis.del(PUBLIC_CACHE_KEY).catch(() => {});
    if (input.excludedFromSlo !== undefined || resolving) await this.rollUp(now).catch(() => {});
    return this.toIncidentView(row);
  }

  async openAutoIncident(probe: ProbeName, now: Date): Promise<IncidentView | null> {
    const autoKey = `sli-down:${probe}`;
    const existing = await this.prisma.platformIncident.findUnique({ where: { autoKey } });
    if (existing) return null;
    const critical = probe === 'api' || probe === 'auth' || probe === 'database';
    const row = await this.prisma.platformIncident.create({
      data: {
        title: `${PROBE_LABELS[probe]} is not responding`,
        status: 'INVESTIGATING',
        impact: critical ? 'CRITICAL' : 'MAJOR',
        components: [probe],
        startedAt: new Date(now.getTime() - 3 * 60_000),
        updates: [{ ts: now.toISOString(), status: 'INVESTIGATING', text: 'Opened automatically: the probe failed for three consecutive minutes.' }],
        createdBy: 'system',
        autoKey,
      },
    });
    await this.redis.del(PUBLIC_CACHE_KEY).catch(() => {});
    return this.toIncidentView(row);
  }

  async resolveAutoIncident(probe: ProbeName, now: Date): Promise<IncidentView | null> {
    const autoKey = `sli-down:${probe}`;
    const existing = await this.prisma.platformIncident.findUnique({ where: { autoKey } });
    if (!existing) return null;
    const updates = Array.isArray(existing.updates) ? [...(existing.updates as unknown[])] : [];
    updates.push({ ts: now.toISOString(), status: 'RESOLVED', text: 'Resolved automatically: the probe has passed for five consecutive minutes.' });
    const row = await this.prisma.platformIncident.update({
      where: { id: existing.id },
      data: { status: 'RESOLVED', resolvedAt: now, autoKey: null, updates: updates as Prisma.InputJsonValue },
    });
    await this.redis.del(PUBLIC_CACHE_KEY).catch(() => {});
    return this.toIncidentView(row);
  }

  // ── Deploy markers ───────────────────────────────────────────────────────

  async recordDeploy(imageTag: string, note?: string | null): Promise<void> {
    const tag = imageTag.trim().slice(0, 80);
    if (!tag) throw new BadRequestException('imageTag is required');
    await this.prisma.platformDeployMarker.create({ data: { imageTag: tag, note: note ? note.slice(0, 300) : null } });
  }

  // ── Canary ───────────────────────────────────────────────────────────────

  async canaryConfig(): Promise<CanaryConfig | null> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: CANARY_SETTING_KEY } });
    const v = row?.value as Partial<CanaryConfig> | null | undefined;
    if (!v || typeof v.projectId !== 'string' || typeof v.anonKey !== 'string') return null;
    return { projectId: v.projectId, anonKey: v.anonKey, storageProbeUrl: v.storageProbeUrl ?? null, createdAt: v.createdAt ?? '' };
  }

  /** The canary's own database, for the pooler probe (password decrypted by the Prisma middleware). */
  async canaryDatabase(): Promise<{ database: string; user: string; password: string } | null> {
    const canary = await this.canaryConfig();
    if (!canary) return null;
    const p = await this.prisma.project.findUnique({
      where: { id: canary.projectId },
      select: { dbName: true, dbUser: true, dbPassword: true, status: true },
    });
    if (!p || p.status === 'DELETED') return null;
    return { database: p.dbName, user: p.dbUser, password: p.dbPassword };
  }

  /**
   * Create the canary once: a real project in the caller's personal
   * organization with table public.slo_probe (one row, readable by the anon
   * role), a public bucket "probe" holding ok.txt, and the ids in a
   * SystemSetting. Idempotent: an existing canary is returned as is.
   */
  async setupCanary(userId: string): Promise<CanaryConfig> {
    const existing = await this.canaryConfig();
    if (existing) return existing;
    const team = await this.prisma.team.findFirst({ where: { personalForUserId: userId }, select: { id: true } });
    if (!team) throw new BadRequestException('The caller has no personal organization to own the canary');

    const project = await this.projects.create(
      { teamId: team.id, name: 'slo-canary', description: 'Availability probe target; do not delete' } as any,
      userId,
    );

    // The probe table, readable by the data API's anon role without policies.
    const row = await this.prisma.project.findUnique({
      where: { id: project.id },
      select: { dbHost: true, dbPort: true, dbName: true, dbUser: true, dbPassword: true, anonKey: true },
    });
    if (!row) throw new NotFoundException('Canary project vanished after creation');
    const pool = new Pool({
      host: row.dbHost,
      port: row.dbPort,
      user: row.dbUser,
      password: row.dbPassword,
      database: row.dbName,
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await pool.query('create table if not exists public.slo_probe (id int primary key)');
      await pool.query('insert into public.slo_probe (id) values (1) on conflict do nothing');
      for (const stmt of [
        'grant usage on schema public to anon, authenticated',
        'grant select on public.slo_probe to anon, authenticated',
      ]) {
        await pool.query(stmt).catch((err: Error) => this.logger.warn(`Canary grant skipped: ${err.message}`));
      }
    } finally {
      await pool.end().catch(() => {});
    }

    let storageProbeUrl: string | null = null;
    try {
      await this.storage.createBucket(project.id, userId, 'probe', true);
      await this.storage.uploadObject(project.id, userId, 'probe', 'ok.txt', Buffer.from('ok\n'), 'text/plain');
      const pub = await this.storage.getPublicUrl(project.id, userId, 'probe', 'ok.txt');
      storageProbeUrl = pub?.url ?? null;
    } catch (err: any) {
      this.logger.warn(`Canary storage probe not set up: ${err?.message ?? err}`);
    }

    const config: CanaryConfig = {
      projectId: project.id,
      anonKey: row.anonKey,
      storageProbeUrl,
      createdAt: new Date().toISOString(),
    };
    await this.prisma.systemSetting.upsert({
      where: { key: CANARY_SETTING_KEY },
      create: { key: CANARY_SETTING_KEY, value: config as unknown as Prisma.InputJsonValue },
      update: { value: config as unknown as Prisma.InputJsonValue },
    });
    this.logger.log(`Canary project created: ${project.id}`);
    return config;
  }

  /** Lets the idle sweep skip the canary (a probe outage must never put it to sleep). */
  async canaryProjectId(): Promise<string | null> {
    return (await this.canaryConfig())?.projectId ?? null;
  }

  errorRate(total: number, errors: number) {
    return errorRatePct(total, errors);
  }
}
