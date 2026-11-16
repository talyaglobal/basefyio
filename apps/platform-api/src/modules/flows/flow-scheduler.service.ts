import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { FlowTrigger } from './flow.types';
import { FlowsService } from './flows.service';
// FlowSchedulerService only orchestrates; cron validation lives in FlowsService.

/**
 * Fires schedule-triggered flows when their next run time is due.
 *
 * Every minute the leader replica queries for enabled flows whose `nextRunAt`
 * is in the past, fires them, then advances `nextRunAt` to the next occurrence.
 * The `nextRunAt` column is set by FlowsService on create/update/triggerScheduled,
 * so a flow only fires once per scheduled slot even if the minute tick is late.
 *
 * The cron-leader election (CronLeaderService) ensures this job runs on exactly
 * one replica at a time, so there is no double-firing risk in a multi-replica
 * deployment.
 */
@Injectable()
export class FlowSchedulerService {
  private readonly logger = new Logger(FlowSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const now = new Date();

    // Find all enabled schedule flows that are due (nextRunAt <= now).
    const due = await this.prisma.flow.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        // Only flows with a schedule trigger have nextRunAt populated.
      },
      select: { id: true, projectId: true, trigger: true },
      // Safety cap: at most 100 due flows per tick to avoid a backlog storm.
      take: 100,
    });

    if (due.length === 0) return;
    this.logger.log(`Firing ${due.length} scheduled flow(s)`);

    const results: PromiseSettledResult<void>[] = await Promise.allSettled(
      due.map(async (flow): Promise<void> => {
        const trigger = flow.trigger as unknown as FlowTrigger;
        if (trigger.type !== 'schedule' || !trigger.cron) return;
        try {
          const runId = await this.flows.triggerScheduled(
            flow.id,
            flow.projectId,
            trigger.cron,
          );
          this.logger.debug(`Scheduled flow ${flow.id} -> run ${runId}`);
        } catch (err: unknown) {
          this.logger.warn(`Failed to fire scheduled flow ${flow.id}: ${(err as Error)?.message}`);
        }
      }),
    );

    const failed = results.filter((r: PromiseSettledResult<void>) => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(`${failed} of ${due.length} scheduled flow(s) failed to enqueue`);
    }
  }
}
