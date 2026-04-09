import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BillingService } from '../billing/billing.service';

@Processor('billing', { concurrency: 1 })
export class BillingProcessor extends WorkerHost {
  private readonly logger = new Logger(BillingProcessor.name);

  constructor(private readonly billingService: BillingService) {
    super();
  }

  async process(job: Job): Promise<any> {
    switch (job.name) {
      case 'recurring-charges':
        return this.processRecurringCharges(job);
      default:
        this.logger.warn(`Unknown job type: ${job.name}`);
        return { error: 'Unknown job type' };
    }
  }

  private async processRecurringCharges(job: Job): Promise<any> {
    this.logger.log('Processing recurring charges...');

    try {
      const result = await this.billingService.processRecurringCharges();

      this.logger.log(
        `Recurring charges complete: ${result.succeeded} succeeded, ${result.failed} failed out of ${result.processed} total`,
      );

      return result;
    } catch (err: any) {
      this.logger.error(`Failed to process recurring charges: ${err.message}`);
      throw err;
    }
  }
}
