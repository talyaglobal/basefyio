import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TENANT_EMBEDDING_QUEUE } from '../queue/queue.module';
import { REEMBED_JOB, TenantEmbeddingService } from './tenant-embedding.service';

export interface TenantReembedJobPayload {
  projectId: string;
}

/**
 * Worker for TENANT_EMBEDDING_QUEUE: rewrites a project's vectors with its
 * current provider. One job at a time — each page is a paid provider call and
 * the project's store is being updated in place. The service records the
 * outcome on the project and never throws, so BullMQ never retries a costly
 * job on its own; the dashboard offers "Retry" instead.
 */
@Processor(TENANT_EMBEDDING_QUEUE, { concurrency: 1, lockDuration: 120_000 })
export class TenantReembedProcessor extends WorkerHost {
  private readonly logger = new Logger(TenantReembedProcessor.name);

  constructor(private readonly tenantEmbedding: TenantEmbeddingService) {
    super();
  }

  async process(job: Job<TenantReembedJobPayload>): Promise<void> {
    if (job.name !== REEMBED_JOB) return;
    const { projectId } = job.data;
    if (!projectId) return;

    const state = await this.tenantEmbedding.reembedProject(projectId);
    this.logger.log(
      `Re-embed job for project ${projectId} finished ${state.status} (${state.done}/${state.total})`,
    );
  }
}
