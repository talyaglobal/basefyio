import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DATA_VECTOR_QUEUE } from '../queue/queue.module';
import {
  DataVectorEmbedderService,
  EMBED_RECORD_JOB,
  REEMBED_ENTITY_JOB,
  type EmbedRecordJob,
  type ReembedEntityJob,
} from './data-vector-embedder.service';

/**
 * Worker for DATA_VECTOR_QUEUE: Data Engine platform vectors.
 *  - embed-record {projectId, entity, id}: after a write, embed the record if its text changed.
 *  - reembed-entity {projectId, entity}: rewrite the entity's vectors, 100 records a page.
 * One job at a time per worker: each embedding is a paid provider call. The
 * service records every outcome and never throws, so BullMQ (attempts 1)
 * never retries a provider failure on its own.
 */
@Processor(DATA_VECTOR_QUEUE, { concurrency: 1, lockDuration: 120_000 })
export class DataVectorProcessor extends WorkerHost {
  private readonly logger = new Logger(DataVectorProcessor.name);

  constructor(private readonly embedder: DataVectorEmbedderService) {
    super();
  }

  async process(job: Job<EmbedRecordJob | ReembedEntityJob>): Promise<void> {
    const { projectId, entity } = job.data ?? ({} as Partial<EmbedRecordJob>);
    if (typeof projectId !== 'string' || !projectId || typeof entity !== 'string' || !entity) return;

    if (job.name === EMBED_RECORD_JOB) {
      const id = (job.data as EmbedRecordJob).id;
      if (typeof id !== 'string' || !id) return;
      await this.embedder.embedRecord({ projectId, entity, id });
      return;
    }
    if (job.name === REEMBED_ENTITY_JOB) {
      const state = await this.embedder.reembedEntity({ projectId, entity });
      this.logger.log(
        `Re-embed of ${entity} (project ${projectId}) finished ${state.status} (${state.done}/${state.total}, ${state.failed} failed)`,
      );
    }
  }
}
