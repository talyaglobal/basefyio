import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FLOW_QUEUE } from '../queue/queue.module';
import { FlowsService } from './flows.service';

interface FlowJobData {
  flowRunId: string;
}

/**
 * Concurrency 10: each process executes up to 10 flow runs in parallel.
 * This prevents one slow flow (e.g. a 10-second HTTP step) from blocking
 * all other projects' flows.
 *
 * lockDuration 90 s covers the worst case of a 10-second http.request action
 * times up to 3 retries + overhead. If a job takes longer than 90 s the lock
 * is extended automatically by BullMQ's built-in keepalive.
 */
@Processor(FLOW_QUEUE, { concurrency: 10, lockDuration: 90_000 })
export class FlowExecuteProcessor extends WorkerHost {
  private readonly logger = new Logger(FlowExecuteProcessor.name);

  constructor(private readonly flows: FlowsService) {
    super();
  }

  async process(job: Job<FlowJobData>): Promise<void> {
    // job.attemptsMade is 0-based (0 = first try); expose 1-based to the service.
    await this.flows.execute(job.data.flowRunId, (job.attemptsMade ?? 0) + 1);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<FlowJobData>, err: Error) {
    this.logger.warn(`flow run ${job?.data?.flowRunId} failed (attempt ${(job?.attemptsMade ?? 0) + 1}): ${err?.message}`);
  }
}
