import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EMBEDDING_QUEUE } from '../queue/queue.module';
import { EmbeddingService } from './embedding.service';
import type { EmbeddingJobPayload } from './types';

@Processor(EMBEDDING_QUEUE, { concurrency: 3, lockDuration: 30_000 })
export class EmbeddingProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbeddingProcessor.name);

  constructor(private readonly embeddingService: EmbeddingService) {
    super();
  }

  async process(job: Job<EmbeddingJobPayload>): Promise<void> {
    const { jobs } = job.data;
    if (!jobs || jobs.length === 0) return;

    this.logger.debug(`Processing ${jobs.length} embedding job(s)`);

    await this.embeddingService.embedBatch(jobs);
  }
}
