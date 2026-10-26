import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../email/email.service';
import { baseLayout } from '../email/templates/base.template';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { BootTaskService } from '../cluster/boot-task.service';
import { MetricsService } from '../health/metrics.service';
import { PlatformAlertsService } from '../platform-alerts/platform-alerts.service';
import { PlatformStatusService, PROBE_LABELS, isPlatformStatusEnabled, platformDomain } from './platform-status.service';
import { PROBES, ProbeName, minuteVerdicts } from './slo';
import { httpProbe, pgProbe, sseProbe } from './probe-runner';
import { shouldOpen, shouldResolve } from './incident-rules';

const INTERNAL = 'internal';
const ERROR_ROUTE_CLASSES = new Set(['rest', 'sql', 'auth']);

/**
 * The internal vantage point: every 30 s, on the scheduler leader, each
 * indicator is probed the way a customer reaches it (public hostnames, TLS,
 * the pooler) and the result is stored. Internal probing is blind to a dead
 * host, so an external monitor feeds the same table through the samples
 * endpoint; the roll-up treats both alike.
 */
@Injectable()
export class PlatformProberService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformProberService.name);
  private running = false;
  /** Last counter snapshot, to turn cumulative histogram counts into a 5-minute delta. */
  private lastCounts: Map<string, number> | null = null;

  constructor(
    private readonly status: PlatformStatusService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly leader: CronLeaderService,
    private readonly metrics: MetricsService,
    private readonly alerts: PlatformAlertsService,
    @Optional() private readonly bootTasks?: BootTaskService,
  ) {}

  /** A deploy marker for this image, once per tag across replicas. */
  onApplicationBootstrap(): void {
    const tag = (process.env.IMAGE_TAG || '').trim();
    if (!tag) return;
    void (async () => {
      try {
        if (!((await this.bootTasks?.claim(`deploy-marker:${tag}`, 24 * 60 * 60_000)) ?? true)) return;
        const recent = await this.prisma.platformDeployMarker.findFirst({
          where: { imageTag: tag, startedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
        });
        if (!recent) await this.status.recordDeploy(tag, 'API started');
      } catch (err: any) {
        this.logger.warn(`Deploy marker skipped: ${err?.message ?? err}`);
      }
    })();
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick(): Promise<void> {
    if (!isPlatformStatusEnabled() || !this.leader.isLeader() || this.running) return;
    this.running = true;
    const now = new Date();
    try {
      const samples = await this.runAll();
      await this.status.recordSamples(INTERNAL, samples.map((s) => ({ ...s, ts: now })));
      await this.evaluateIncidents(now);
    } catch (err: any) {
      this.logger.warn(`Probe tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async rollUpTick(): Promise<void> {
    if (!isPlatformStatusEnabled() || !this.leader.isLeader()) return;
    const now = new Date();
    try {
      const errorRate = await this.accumulateErrorRate(now);
      await this.status.rollUp(now, errorRate);
      if (now.getUTCMinutes() < 5) {
        const pruned = await this.status.pruneSamples(now);
        if (pruned > 0) this.logger.log(`Pruned ${pruned} probe samples older than 90 days`);
      }
    } catch (err: any) {
      this.logger.warn(`Roll-up failed: ${err?.message ?? err}`);
    }
  }

  // ── Probes ───────────────────────────────────────────────────────────────

  async runAll(): Promise<Array<{ probe: ProbeName; ok: boolean; latencyMs: number; statusCode?: number; detail?: string }>> {
    const d = platformDomain();
    const canary = await this.status.canaryConfig();
    const keyed = canary ? { apikey: canary.anonKey } : null;

    const tasks: Array<Promise<{ probe: ProbeName; ok: boolean; latencyMs: number; statusCode?: number; detail?: string } | null>> = [
      (async () => {
        const ready = await httpProbe(`https://api.${d}/api/health/ready`, 3000);
        if (!ready.ok || !keyed) return { probe: 'api', ...ready };
        const rest = await httpProbe(`https://api.${d}/api/rest/v1/slo_probe?select=id&limit=1`, 1000, keyed);
        return { probe: 'api', ...rest };
      })(),
      httpProbe(`https://app.${d}/login`, 3000).then((r) => ({ probe: 'dashboard' as const, ...r })),
      httpProbe(`https://auth.${d}/realms/master/.well-known/openid-configuration`, 3000).then((r) => ({ probe: 'auth' as const, ...r })),
      (async () => {
        const db = await this.status.canaryDatabase();
        if (!db) return null;
        const r = await pgProbe({ host: `db.${d}`, port: 6432, ...db }, 2000);
        return { probe: 'database' as const, ...r };
      })(),
      (async () => {
        if (!canary?.storageProbeUrl) return null;
        const r = await httpProbe(canary.storageProbeUrl, 3000);
        return { probe: 'storage' as const, ...r };
      })(),
      (async () => {
        if (!keyed) return null;
        const r = await sseProbe(`https://api.${d}/api/realtime/v1/stream?channels=slo_probe`, 5000, keyed);
        return { probe: 'realtime' as const, ...r };
      })(),
    ];
    const settled = await Promise.allSettled(tasks);
    const out: Array<{ probe: ProbeName; ok: boolean; latencyMs: number; statusCode?: number; detail?: string }> = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) out.push(s.value);
    }
    return out;
  }

  // ── Incidents ────────────────────────────────────────────────────────────

  async evaluateIncidents(now: Date): Promise<void> {
    const samples = await this.status.samplesSince(new Date(now.getTime() - 8 * 60_000));
    for (const probe of PROBES) {
      const verdicts = minuteVerdicts(samples.filter((s) => s.probe === probe));
      if (verdicts.length === 0) continue;
      if (shouldOpen(verdicts, now)) {
        const opened = await this.status.openAutoIncident(probe, now);
        if (opened) await this.announceDown(probe, opened.id);
      } else if (shouldResolve(verdicts, now)) {
        const resolved = await this.status.resolveAutoIncident(probe, now);
        if (resolved) await this.announceUp(probe);
      }
    }
  }

  private async announceDown(probe: ProbeName, incidentId: string): Promise<void> {
    const label = PROBE_LABELS[probe];
    await this.alerts.raise({
      kind: `sli_down_${probe}`,
      severity: 'critical',
      title: `${label} is down: the probe has failed for three minutes`,
      detail: `Incident ${incidentId} opened automatically. See the Reliability page and https://${platformDomain()}/status.`,
      metadata: { probe, incidentId },
    });
    try {
      const roots = await this.prisma.user.findMany({ where: { role: 'ROOT' }, select: { email: true } });
      const html = baseLayout(
        `<div class="body"><h1 class="greeting">${label} is down</h1>` +
          `<p class="text">The availability probe for <strong>${label}</strong> has failed for three consecutive minutes. ` +
          `An incident was opened on the status page; it resolves itself after five clean minutes.</p>` +
          `<p class="text"><a href="https://${platformDomain()}/status">Status page</a></p></div>`,
      );
      await Promise.all(roots.map((r) => this.email.sendRawHtml(r.email, `[ROOT Alert] ${label} is down`, html)));
    } catch (err: any) {
      this.logger.warn(`Could not e-mail ROOT users: ${err?.message ?? err}`);
    }
  }

  private async announceUp(probe: ProbeName): Promise<void> {
    await this.prisma.platformAlert
      .updateMany({
        where: { kind: `sli_down_${probe}`, acknowledgedAt: null },
        data: { acknowledgedAt: new Date(), acknowledgedBy: 'system' },
      })
      .catch(() => {});
    this.logger.log(`${PROBE_LABELS[probe]} recovered; auto incident resolved`);
  }

  // ── Error rate ───────────────────────────────────────────────────────────

  /**
   * Share of 5xx answers on the rest/sql/auth route classes, accumulated per
   * UTC day from this process's cumulative counters. Only the leader's own
   * traffic is seen; with one replica that is all of it.
   */
  private async accumulateErrorRate(now: Date): Promise<number | null> {
    const counts = this.metrics.routeStatusCounts();
    const current = new Map<string, number>();
    for (const c of counts) {
      if (!ERROR_ROUTE_CLASSES.has(c.routeClass)) continue;
      current.set(`${c.routeClass}|${c.statusClass}`, c.count);
    }
    let total = 0;
    let errors = 0;
    if (this.lastCounts) {
      for (const [key, value] of current) {
        const delta = Math.max(0, value - (this.lastCounts.get(key) ?? 0));
        total += delta;
        if (key.endsWith('|5xx')) errors += delta;
      }
    }
    this.lastCounts = current;
    const day = now.toISOString().slice(0, 10);
    const ttl = 2 * 24 * 60 * 60;
    try {
      const client = this.redis.getClient();
      const [t, e] = await Promise.all([
        client.incrby(`pstatus:err:${day}:total`, total),
        client.incrby(`pstatus:err:${day}:errors`, errors),
      ]);
      await Promise.all([client.expire(`pstatus:err:${day}:total`, ttl), client.expire(`pstatus:err:${day}:errors`, ttl)]);
      return this.status.errorRate(Number(t), Number(e));
    } catch {
      return this.status.errorRate(total, errors);
    }
  }
}
