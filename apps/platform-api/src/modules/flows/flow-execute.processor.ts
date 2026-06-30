import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FLOW_QUEUE } from '../queue/queue.module';
import { FlowsService } from './flows.service';

interface FlowJobData {
  flowRunId: string;
}

@Processor(FLOW_QUEUE)
export class FlowExecuteProcessor extends WorkerHost {
  private readonly logger = new Logger(FlowExecuteProcessor.name);

  constructor(private readonly flows: FlowsService) {
    super();
  }

  async process(job: Job<FlowJobData>): Promise<void> {
    await this.flows.execute(job.data.flowRunId);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<FlowJobData>, err: Error) {
    this.logger.warn(`flow run ${job?.data?.flowRunId} failed: ${err?.message}`);
  }
}
