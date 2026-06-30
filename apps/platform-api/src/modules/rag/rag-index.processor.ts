import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RAG_INDEX_QUEUE } from '../queue/queue.module';
import { RagRepository } from './rag.repository';
import { RagIndexerService } from './rag-indexer.service';
import type { RagIndexJobPayload } from './rag.service';

/**
 * BullMQ consumer for RAG_INDEX_QUEUE (the "rag_embedding_job" worker).
 * Marks the job RUNNING, delegates the chunk→embed→store work to the indexer,
 * then records COMPLETED/FAILED on the job row.
 */
@Processor(RAG_INDEX_QUEUE, { concurrency: 2, lockDuration: 60_000 })
export class RagIndexProcessor extends WorkerHost {
  private readonly logger = new Logger(RagIndexProcessor.name);

  constructor(
    private readonly repo: RagRepository,
    private readonly indexer: RagIndexerService,
  ) {
    super();
  }

  async process(job: Job<RagIndexJobPayload>): Promise<void> {
    const payload = job.data;
    // markJobRunning sets status RUNNING unconditionally, so a BullMQ retry of a
    // job whose row is already FAILED transitions FAILED → RUNNING cleanly.
    await this.repo.markJobRunning(payload.jobId);
    try {
      const { processedDocs, failedDocs, totalChunks } =
        await this.indexer.runJob(payload);

      // Per-document failures don't throw (each bad doc is marked FAILED on its
      // own row). Escalate the JOB to FAILED only when every target failed and
      // nothing was produced; partial success stays COMPLETED with the failed
      // documents observable via their own status. No throw here, so BullMQ does
      // not retry an all-failed job — re-run it via reindex.
      if (failedDocs > 0 && totalChunks === 0) {
        await this.repo.markJobFailed(
          payload.jobId,
          `Failed ${failedDocs} document(s)`,
        );
        return;
      }

      await this.repo.markJobCompleted(payload.jobId, {
        processedDocs,
        totalChunks,
      });
    } catch (err: any) {
      this.logger.error(
        `RAG index job ${payload.jobId} failed: ${err?.message ?? err}`,
      );
      await this.repo.markJobFailed(
        payload.jobId,
        String(err?.message ?? err),
      );
      throw err; // let BullMQ apply retry/backoff
    }
  }
}
