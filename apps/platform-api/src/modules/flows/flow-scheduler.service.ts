import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementKey } from '../entitlement/entitlement-key';
import { cronMatches, floorToMinute, parseCron, ParsedCron } from './flow-cron';
import { readStoredTrigger } from './flow-definition';
import { FlowsService, RUNNABLE_PROJECT_STATUSES } from './flows.service';

/** How far back a tick looks for minutes it may have missed (a late tick, a leader handover). */
export const SCHEDULE_GRACE_MINUTES = 2;

/**
 * Fires schedule-triggered flows.
 *
 * Exactly once per tick on a multi-replica deployment, by the same two layers
 * every other scheduled job here relies on:
 *
 *  1. The tick is a `@Cron` job, so the cron leader election (ClusterModule)
 *     runs it on one replica and holds it paused on the others.
 *  2. Each run is written with a dedupe key `schedule:<flowId>:<minute>` under
 *     a unique index. If two replicas ever tick at once — Redis unreachable for
 *     longer than the lease, a handover mid-minute — the second insert is
 *     refused by the database and nothing is queued twice.
 *
 * Each tick also re-checks the previous minute(s), so a tick that fires late
 * or lands on a fresh leader still produces the run; the dedupe key makes the
 * look-back free of duplicates. Only the latest due minute is fired, so the
 * look-back recovers a missed tick but never replays a burst, and a tick that
 * came before the flow was last saved is never fired, so enabling or editing a
 * flow does not back-fill a run.
 *
 * A tick is skipped while an earlier scheduled run of the same flow is still
 * waiting to start, so a schedule faster than its runs cannot pile up a
 * backlog.
 */
@Injectable()
export class FlowSchedulerService {
  private readonly logger = new Logger(FlowSchedulerService.name);
  private readonly parsedCache = new Map<string, ParsedCron | null>();
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
    private readonly entitlement: EntitlementService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'flow-schedules' })
  async onTick(): Promise<void> {
    if (this.ticking) return; // the previous tick is still going; the look-back covers it
    this.ticking = true;
    try {
      await this.tick(new Date());
      const abandoned = await this.flows.failAbandonedRuns();
      if (abandoned) this.logger.warn(`Marked ${abandoned} abandoned flow run(s) as failed`);
    } catch (err: any) {
      this.logger.error(`Flow schedule tick failed: ${err?.message}`);
    } finally {
      this.ticking = false;
    }
  }

  private parse(cron: string): ParsedCron | null {
    if (!this.parsedCache.has(cron)) {
      try {
        this.parsedCache.set(cron, parseCron(cron));
      } catch {
        this.parsedCache.set(cron, null);
      }
      if (this.parsedCache.size > 5000) this.parsedCache.clear();
    }
    return this.parsedCache.get(cron) ?? null;
  }

  /** Fire every due schedule for the minute containing `now`. Returns the runs created. */
  async tick(now: Date): Promise<number> {
    const minute = floorToMinute(now);
    const candidates: Date[] = [];
    for (let back = SCHEDULE_GRACE_MINUTES; back >= 0; back--) {
      candidates.push(new Date(minute.getTime() - back * 60_000));
    }

    const flows = await this.prisma.flow.findMany({
      where: { enabled: true, trigger: { path: ['type'], equals: 'schedule' } },
      select: { id: true, projectId: true, trigger: true, updatedAt: true },
    });
    if (!flows.length) return 0;

    const projectIds = [...new Set(flows.map((f) => f.projectId))];
    const runnable = new Set(
      (
        await this.prisma.project.findMany({
          where: { id: { in: projectIds }, status: { in: [...RUNNABLE_PROJECT_STATUSES] } },
          select: { id: true },
        })
      ).map((p) => p.id),
    );
    const entitled = new Map<string, boolean>();

    let created = 0;
    for (const flow of flows) {
      if (!runnable.has(flow.projectId)) continue;
      const trigger = readStoredTrigger(flow.trigger);
      if (!trigger.cron) continue;
      const cron = this.parse(trigger.cron);
      if (!cron) continue;
      const tz = trigger.timezone || 'UTC';
      const savedAt = flow.updatedAt.getTime();
      let due: Date[];
      try {
        due = candidates.filter((t) => t.getTime() >= savedAt && cronMatches(cron, t, tz));
      } catch {
        continue; // a time zone this runtime no longer knows
      }
      if (!due.length) continue;

      if (!entitled.has(flow.projectId)) {
        entitled.set(flow.projectId, await this.entitlement.can(flow.projectId, EntitlementKey.FLOWS));
      }
      if (!entitled.get(flow.projectId)) continue;

      const waiting = await this.prisma.flowRun.count({
        where: { flowId: flow.id, source: 'schedule', status: 'queued' },
      });
      if (waiting > 0) continue;

      // Only the most recent due minute: a look-back recovers a missed tick,
      // it does not replay a burst.
      const tickAt = due[due.length - 1];
      try {
        const run = await this.flows.createRun(flow, {
          source: 'schedule',
          input: null,
          meta: { scheduledFor: tickAt.toISOString(), cron: trigger.cron, timezone: tz },
          dedupeKey: `schedule:${flow.id}:${tickAt.toISOString()}`,
        });
        if (run) created++;
      } catch (err: any) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        this.logger.warn(`Could not queue scheduled run of flow ${flow.id}: ${err?.message}`);
      }
    }
    if (created) this.logger.log(`Queued ${created} scheduled flow run(s) for ${minute.toISOString()}`);
    return created;
  }
}
