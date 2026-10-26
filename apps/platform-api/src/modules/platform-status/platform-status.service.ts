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
  aggregateWindows,
  availabilityPct,
  burnRate,
  errorBudgetMinutes,
  errorRatePct,
  minuteVerdicts,
  minutesInMonth,
  monthKey,
  monthStartUtc,
  nextMonthStartUtc,
  parseMonthKey,
  summarise,
  targetMet,
} from './slo';
import type {
  ComponentState,
  ComponentStatus,
  ConsoleStatus,
  DayFigure,
  IncidentView,
  MonthComponent,
  PublicStatus,
  StatusHistory,
  TrackedComponent,
} from './platform-status.types';
import { StatusSubscriptionsService } from './status-subscriptions.service';

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

/** What each probe exercises, as the status page lists it under the component ("<domain>" is filled in). */
export const PROBE_COVERS: Record<ProbeName, string[]> = {
  api: [
    'api.<domain> readiness (/api/health/ready)',
    'REST data API (/api/rest/v1) with a project key, through admission control',
    'Management API behind the dashboard (/api/projects, /api/organizations, …)',
  ],
  dashboard: ['app.<domain> sign-in page', 'The dashboard\'s proxy to the API (/api/proxy)', 'admin.<domain> root console'],
  auth: ['auth.<domain> OpenID discovery (Keycloak)', 'Sign-in, tokens and sessions for every project realm', 'Password reset and verification mail'],
  database: ['db.<domain>:6432 connection pooler over TLS', 'SELECT 1 on a project database through the pooler', 'Read-only roles and direct connections'],
  storage: ['storage.<domain> public object download', 'Buckets, uploads and signed URLs (S3-compatible)'],
  realtime: ['Server-sent event stream (/api/realtime/v1/stream)', 'Change feeds and channel bindings'],
};

/** Parts of the service without a probe; an open incident that lists one sets its state. */
export const TRACKED_COMPONENTS: Array<{ id: string; label: string; covers: string[] }> = [
  { id: 'provisioning', label: 'Project provisioning', covers: ['New project databases and realms', 'Branches, restores and project activation'] },
  { id: 'backups', label: 'Backups & point-in-time recovery', covers: ['Nightly base backups', 'WAL archiving and restores'] },
  { id: 'billing', label: 'Billing & payments', covers: ['Checkout, invoices and plan changes (Stripe)'] },
  { id: 'website', label: 'Website & docs', covers: ['<domain>', 'docs.<domain>', 'status.<domain>'] },
  { id: 'email', label: 'E-mail delivery', covers: ['Sign-up, reset, invite and project mail'] },
];

export const COMPONENT_IDS: readonly string[] = [...PROBES, ...TRACKED_COMPONENTS.map((t) => t.id)];

export const COMPONENT_LABELS: Record<string, string> = {
  ...PROBE_LABELS,
  ...Object.fromEntries(TRACKED_COMPONENTS.map((t) => [t.id, t.label])),
};

const HISTORY_CACHE_PREFIX = 'pstatus:history:';
const withDomain = (lines: string[]) => lines.map((l) => l.split('<domain>').join(platformDomain()));

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
    private readonly subscriptions: StatusSubscriptionsService,
  ) {}

  /** The public payload and the current month's history are cached; both go when anything they show changes. */
  private async invalidatePublic(): Promise<void> {
    await Promise.all([
      this.redis.del(PUBLIC_CACHE_KEY).catch(() => {}),
      this.redis.del(`${HISTORY_CACHE_PREFIX}${monthKey(new Date())}`).catch(() => {}),
    ]);
  }

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
    await this.rollUpMonths(now);
    await this.invalidatePublic();
  }

  /**
   * The month's figure per probe, recomputed as the month runs and kept as
   * the status page's history. The previous month is recomputed too, so the
   * day that straddles midnight on the first is settled; once a month has
   * ended its closed_at is set and never moved.
   */
  async rollUpMonths(now: Date): Promise<void> {
    const thisMonth = monthStartUtc(now);
    const prevMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 1));
    for (const month of [prevMonth, thisMonth]) {
      const end = nextMonthStartUtc(month);
      const [windows, incidents] = await Promise.all([
        this.prisma.platformSloWindow.findMany({ where: { day: { gte: month, lt: end } } }),
        this.prisma.platformIncident.findMany({
          where: { startedAt: { gte: month, lt: end }, excludedFromSlo: false },
          select: { components: true },
        }),
      ]);
      if (windows.length === 0) continue;
      const ended = end.getTime() <= now.getTime();
      for (const probe of PROBES) {
        const own = windows.filter((w) => w.probe === probe);
        if (own.length === 0) continue;
        const sum = aggregateWindows(own);
        const data = {
          totalMinutes: sum.totalMinutes,
          downMinutes: sum.downMinutes,
          availabilityPct: availabilityPct(sum.totalMinutes, sum.downMinutes),
          targetPct: SLO_TARGET_PCT[probe],
          p95LatencyMs: sum.p95LatencyMs,
          incidentCount: incidents.filter((i) => i.components.includes(probe)).length,
        };
        await this.prisma.platformSloMonth.upsert({
          where: { month_probe: { month, probe } },
          create: { month, probe, ...data, closedAt: ended ? now : null },
          update: data,
        });
      }
      if (ended) {
        await this.prisma.platformSloMonth.updateMany({ where: { month, closedAt: null }, data: { closedAt: now } });
      }
    }
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
    const [windows, recentSamples, incidents, monthRows] = await Promise.all([
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
      this.prisma.platformSloMonth.findMany({ select: { month: true }, distinct: ['month'], orderBy: { month: 'asc' } }),
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
        covers: withDomain(PROBE_COVERS[probe]),
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

    // Components without a probe: an open incident naming them is the only signal.
    const openAny = views.filter((i) => i.status !== 'RESOLVED');
    const tracked: TrackedComponent[] = TRACKED_COMPONENTS.map((t) => {
      const hits = openAny.filter((i) => i.components.includes(t.id));
      const severe = hits.some((i) => !i.excludedFromSlo && (i.impact === 'CRITICAL' || i.impact === 'MAJOR'));
      const state: ComponentState = severe ? 'down' : hits.length > 0 ? 'degraded' : 'operational';
      return { id: t.id, label: t.label, covers: withDomain(t.covers), state };
    });

    const probeStates = components.map((c) => c.state);
    const states = [...probeStates, ...tracked.map((t) => t.state)];
    const overall: ComponentState = states.includes('down')
      ? 'down'
      : states.includes('degraded')
        ? 'degraded'
        : probeStates.every((s) => s === 'unknown')
          ? 'unknown'
          : 'operational';

    const months = monthRows.map((m) => monthKey(m.month));
    const currentMonth = monthKey(now);
    if (!months.includes(currentMonth)) months.push(currentMonth);

    return {
      generatedAt: now.toISOString(),
      domain: platformDomain(),
      overall,
      components,
      incidents: { open, recent },
      maintenance,
      tracked,
      months,
      live: anyLive,
      vantages: Array.from(vantages).sort(),
    };
  }

  /** One calendar month of history; the current month by default. Cached a minute while it runs, an hour once closed. */
  async history(monthParam?: string): Promise<StatusHistory> {
    const now = new Date();
    const month = parseMonthKey(monthParam) ?? monthStartUtc(now);
    if (month.getTime() > monthStartUtc(now).getTime()) throw new BadRequestException('That month has not started');
    const cacheKey = `${HISTORY_CACHE_PREFIX}${monthKey(month)}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as StatusHistory;
    } catch {
      /* compute */
    }
    const built = await this.buildHistory(month, now);
    await this.redis.set(cacheKey, JSON.stringify(built), built.closed ? 3600 : 60).catch(() => {});
    return built;
  }

  async buildHistory(month: Date, now: Date): Promise<StatusHistory> {
    const end = nextMonthStartUtc(month);
    const [windows, monthRows, incidents, monthsWithData] = await Promise.all([
      this.prisma.platformSloWindow.findMany({ where: { day: { gte: month, lt: end } } }),
      this.prisma.platformSloMonth.findMany({ where: { month } }),
      this.prisma.platformIncident.findMany({ where: { startedAt: { gte: month, lt: end } }, orderBy: { startedAt: 'desc' } }),
      this.prisma.platformSloMonth.findMany({ select: { month: true }, distinct: ['month'], orderBy: { month: 'asc' } }),
    ]);
    const daysInMonth = Math.round((end.getTime() - month.getTime()) / 86_400_000);
    const today = dayStart(now);

    const components: MonthComponent[] = PROBES.map((probe) => {
      const own = windows.filter((w) => w.probe === probe);
      const row = monthRows.find((r) => r.probe === probe);
      const sum = row ? { totalMinutes: row.totalMinutes, downMinutes: row.downMinutes, p95LatencyMs: row.p95LatencyMs } : aggregateWindows(own);
      const avail = availabilityPct(sum.totalMinutes, sum.downMinutes);
      const days: DayFigure[] = [];
      for (let i = 0; i < daysInMonth; i++) {
        const day = new Date(month.getTime() + i * 86_400_000);
        const w = own.find((x) => x.day.getTime() === day.getTime());
        days.push({
          day: dayKey(day),
          availabilityPct: w ? availabilityPct(w.totalMinutes, w.downMinutes) : null,
          downMinutes: w?.downMinutes ?? 0,
          totalMinutes: w?.totalMinutes ?? 0,
          ...(day.getTime() > today.getTime() ? { future: true } : {}),
        });
      }
      return {
        probe,
        label: PROBE_LABELS[probe],
        targetPct: SLO_TARGET_PCT[probe],
        availabilityPct: avail,
        downMinutes: sum.downMinutes,
        observedMinutes: sum.totalMinutes,
        p95LatencyMs: sum.p95LatencyMs,
        met: targetMet(avail, SLO_TARGET_PCT[probe]),
        incidentCount: row?.incidentCount ?? incidents.filter((i) => !i.excludedFromSlo && i.components.includes(probe)).length,
        days,
      };
    });

    const keys = monthsWithData.map((m) => monthKey(m.month));
    const current = monthKey(now);
    if (!keys.includes(current)) keys.push(current);
    const key = monthKey(month);
    const earlier = keys.filter((k) => k < key);
    return {
      month: key,
      from: month.toISOString(),
      to: end.toISOString(),
      closed: end.getTime() <= now.getTime(),
      components,
      incidents: incidents.map((i) => this.toIncidentView(i)),
      months: keys,
      prevMonth: earlier.length ? earlier[earlier.length - 1] : null,
      nextMonth: keys.find((k) => k > key) ?? null,
    };
  }

  async consoleStatus(): Promise<ConsoleStatus> {
    const now = new Date();
    const pub = await this.buildPublic(now);
    const since24h = new Date(now.getTime() - 24 * 60 * 60_000);
    const [samples24h, todayApi, deploys, latest, events, canary, subscribers] = await Promise.all([
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
      this.subscriptions.counts(),
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
      subscribers,
      componentOptions: COMPONENT_IDS.map((id) => ({ id, label: COMPONENT_LABELS[id] ?? id })),
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
        components: (input.components ?? []).filter((c) => COMPONENT_IDS.includes(c)),
        startedAt: input.startedAt ? new Date(input.startedAt) : now,
        excludedFromSlo: !!input.excludedFromSlo,
        updates,
        createdBy,
        ...(status === 'RESOLVED' ? { resolvedAt: now } : {}),
      },
    });
    await this.invalidatePublic();
    const view = this.toIncidentView(row);
    void this.subscriptions.notifyIncident(view, status === 'RESOLVED' ? 'resolved' : 'opened', COMPONENT_LABELS);
    return view;
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
        ...(input.components !== undefined ? { components: input.components.filter((c) => COMPONENT_IDS.includes(c)) } : {}),
        ...(input.startedAt !== undefined ? { startedAt: new Date(input.startedAt) } : {}),
        ...(input.excludedFromSlo !== undefined ? { excludedFromSlo: input.excludedFromSlo } : {}),
        ...(input.postmortem !== undefined ? { postmortem: input.postmortem } : {}),
        ...(resolving ? { resolvedAt: now, autoKey: null } : {}),
        updates: updates as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Incident ${id} updated by ${by}: ${nextStatus}`);
    await this.invalidatePublic();
    if (input.excludedFromSlo !== undefined || resolving) await this.rollUp(now).catch(() => {});
    const view = this.toIncidentView(row);
    const announced = updates.length > (Array.isArray(current.updates) ? (current.updates as unknown[]).length : 0);
    if (resolving) void this.subscriptions.notifyIncident(view, 'resolved', COMPONENT_LABELS);
    else if (announced) void this.subscriptions.notifyIncident(view, 'updated', COMPONENT_LABELS);
    return view;
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
    await this.invalidatePublic();
    const view = this.toIncidentView(row);
    void this.subscriptions.notifyIncident(view, 'opened', COMPONENT_LABELS);
    return view;
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
    await this.invalidatePublic();
    const view = this.toIncidentView(row);
    void this.subscriptions.notifyIncident(view, 'resolved', COMPONENT_LABELS);
    return view;
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
