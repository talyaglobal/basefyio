import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../email/email.service';
import { PlanEnforcementService } from './plan-enforcement.service';
import { mauMonth } from './mau-tracker.service';
import { EnforcedMetric, MetricState, formatFigure } from './plan-enforcement.rules';

/** A sent notice is remembered a little longer than the month it belongs to. */
const SENT_TTL_SECONDS = 40 * 24 * 60 * 60;

const CONSEQUENCE: Record<EnforcedMetric, { at80: string; at100: string }> = {
  api_requests: {
    at80: 'Nothing changes yet. At 110% of the limit, API requests are refused (HTTP 429) until the counter resets on the 1st or you upgrade.',
    at100: 'You are inside a 10% grace. At 110% of the limit, API requests are refused (HTTP 429) until the counter resets on the 1st or you upgrade.',
  },
  egress: {
    at80: 'Nothing changes yet. At 110% of the limit, requests are refused (HTTP 429) until the counter resets on the 1st or you upgrade.',
    at100: 'You are inside a 10% grace. At 110% of the limit, requests are refused (HTTP 429) until the counter resets on the 1st or you upgrade.',
  },
  mau: {
    at80: 'Nothing changes yet. At 110% of the limit, new sign-ups to your projects are refused; existing users keep signing in.',
    at100: 'You are inside a 10% grace. At 110% of the limit, new sign-ups to your projects are refused; existing users keep signing in.',
  },
  db_size: {
    at80: 'Nothing changes yet. At 110% of the limit, writes that add data are refused (HTTP 402); reading and deleting keep working.',
    at100: 'You are inside a 10% grace. At 110% of the limit, writes that add data are refused (HTTP 402); reading and deleting keep working.',
  },
};

export function alertKey(teamId: string, month: string, metric: EnforcedMetric, threshold: 80 | 100): string {
  return `plan_alert:${teamId}:${month}:${metric}:${threshold}`;
}

/** The threshold a metric has crossed, or null below 80%. */
export function thresholdOf(m: MetricState): 80 | 100 | null {
  if (m.level === 'limit' || m.level === 'over_grace') return 100;
  if (m.level === 'warning') return 80;
  return null;
}

/**
 * Hourly, after the measurements: mail the owners of an organization whose
 * usage of an ENFORCED limit crossed 80% or 100%. Once per organization,
 * metric, threshold and month (a Redis marker on the durable instance); a
 * notice that reached nobody is not marked, so it is tried again next hour.
 * Metrics in warn or off mode never mail.
 */
@Injectable()
export class PlanUsageAlertsService {
  private readonly logger = new Logger(PlanUsageAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly enforcement: PlanEnforcementService,
  ) {}

  @Cron('20 * * * *')
  async run(now: Date = new Date()): Promise<number> {
    const modes = await this.enforcement.modes();
    if (!Object.values(modes).includes('enforce')) return 0;
    const subs = await this.prisma.subscription.findMany({
      select: { teamId: true, team: { select: { name: true } } },
    });
    let sent = 0;
    for (const sub of subs) {
      try {
        sent += await this.alertTeam(sub.teamId, sub.team?.name ?? 'Your organization', now);
      } catch (err: any) {
        this.logger.warn(`Plan usage alerts failed for team ${sub.teamId}: ${err?.message ?? err}`);
      }
    }
    if (sent > 0) this.logger.log(`Plan usage notices sent: ${sent}`);
    return sent;
  }

  async alertTeam(teamId: string, teamName: string, now: Date = new Date()): Promise<number> {
    const state = await this.enforcement.teamState(teamId, { fresh: true });
    if (state.exempt) return 0;
    const month = mauMonth(now);
    const store = this.redis.durable();
    let sent = 0;
    for (const m of state.metrics) {
      if (m.mode !== 'enforce' || m.limit === null) continue;
      const threshold = thresholdOf(m);
      if (!threshold) continue;
      const key = alertKey(teamId, month, m.metric, threshold);
      if (await store.get(key)) continue;
      const to = await this.owners(teamId);
      if (to.length === 0) continue;
      let delivered = 0;
      for (const address of to) {
        try {
          await this.email.sendPlanUsageNotice(address, {
            teamName,
            planName: state.planDisplayName ?? 'current',
            label: m.label,
            current: formatFigure(m.current, m.unit),
            limit: formatFigure(m.limit, m.unit),
            threshold,
            consequence: threshold >= 100 ? CONSEQUENCE[m.metric].at100 : CONSEQUENCE[m.metric].at80,
          });
          delivered++;
        } catch (err: any) {
          this.logger.warn(`Plan usage notice to ${address} failed: ${err?.message ?? err}`);
        }
      }
      if (delivered === 0) continue;
      await store.set(key, '1', SENT_TTL_SECONDS);
      // Reaching 100% first also covers 80%: never send the smaller notice afterwards.
      if (threshold === 100) await store.set(alertKey(teamId, month, m.metric, 80), '1', SENT_TTL_SECONDS);
      sent++;
    }
    return sent;
  }

  private async owners(teamId: string): Promise<string[]> {
    const members = await this.prisma.teamMember.findMany({
      where: { teamId, role: 'OWNER' },
      select: { user: { select: { email: true } } },
    });
    const seen = new Set<string>();
    for (const m of members) {
      const email = m.user?.email?.trim();
      if (email) seen.add(email.toLowerCase());
    }
    return [...seen];
  }
}
