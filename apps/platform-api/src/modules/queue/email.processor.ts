import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailService } from '../email/email.service';
import { EMAIL_QUEUE } from './queue.module';

export interface EmailJobData {
  type: 'imported-user-credentials';
  to: string;
  username: string;
  tempPassword: string;
  projectName: string;
}

@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly emailService: EmailService) {
    super();
  }

  async process(job: Job<EmailJobData>): Promise<void> {
    const { type, to, username, tempPassword, projectName } = job.data;

    this.logger.log(`Processing email job ${job.id}: ${type} -> ${to}`);

    switch (type) {
      case 'imported-user-credentials':
        await this.emailService.sendImportedUserCredentials(
          to,
          username,
          tempPassword,
          projectName,
        );
        break;
      default:
        this.logger.warn(`Unknown email job type: ${type}`);
    }
  }
}
