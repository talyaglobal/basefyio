import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { BILLING_QUEUE } from '../queue/queue.module';

/**
 * Enqueues the daily recurring-charge run.
 *
 * Declared as a cron job rather than the hand-rolled setTimeout/setInterval it
 * replaces, so that when the API runs as more than one replica the leader
 * election in ClusterModule can pause it everywhere but one process — a raw
 * timer is invisible to the scheduler registry and would have fired on every
 * replica. The job id carries the date as a second guard: BullMQ ignores an add
 * whose id already exists, so even two enqueues on one day yield one charge run.
 */
@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);

  constructor(
    @InjectQueue(BILLING_QUEUE)
    private readonly billingQueue: Queue,
  ) {}

  /** Daily at 10:00 UTC — the hour the previous timer-based schedule used. */
  @Cron('0 10 * * *', { timeZone: 'UTC' })
  async triggerRecurringCharges(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    try {
      await this.billingQueue.add(
        'recurring-charges',
        {},
        {
          jobId: `recurring-charges-${day}`,
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 1,
        },
      );
      this.logger.log(`Recurring charges job queued for ${day}`);
    } catch (err: any) {
      this.logger.error(`Failed to queue recurring charges: ${err.message}`);
    }
  }
}
