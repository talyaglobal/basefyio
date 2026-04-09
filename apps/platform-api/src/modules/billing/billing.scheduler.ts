import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BILLING_QUEUE } from '../queue/queue.module';

@Injectable()
export class BillingScheduler implements OnModuleInit {
  private readonly logger = new Logger(BillingScheduler.name);
  private intervalId?: NodeJS.Timeout;

  constructor(
    @InjectQueue(BILLING_QUEUE)
    private readonly billingQueue: Queue,
  ) {}

  async onModuleInit() {
    // Schedule recurring charges to run daily at the configured hour
    // For production: run at configured hour (default: 10:00 AM UTC)
    // For simplicity, we'll run it every day at 10:00
    this.scheduleDailyRecurringCharges();
  }

  private scheduleDailyRecurringCharges() {
    // Calculate time until next 10:00 AM UTC
    const now = new Date();
    const next10AM = new Date();
    next10AM.setUTCHours(10, 0, 0, 0);

    // If it's already past 10 AM today, schedule for tomorrow
    if (now.getUTCHours() >= 10) {
      next10AM.setUTCDate(next10AM.getUTCDate() + 1);
    }

    const msUntilNext = next10AM.getTime() - now.getTime();

    this.logger.log(
      `Scheduling recurring charges. First run at ${next10AM.toISOString()} (in ${Math.round(msUntilNext / 1000 / 60)} minutes)`,
    );

    // Schedule first run
    setTimeout(
      () => {
        this.triggerRecurringCharges();
        // After first run, repeat every 24 hours
        this.intervalId = setInterval(() => this.triggerRecurringCharges(), 24 * 60 * 60 * 1000);
      },
      msUntilNext,
    );
  }

  private async triggerRecurringCharges() {
    try {
      await this.billingQueue.add(
        'recurring-charges',
        {},
        {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 1,
        },
      );
      this.logger.log('Recurring charges job queued');
    } catch (err: any) {
      this.logger.error(`Failed to queue recurring charges: ${err.message}`);
    }
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }
}
