import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FlowsService } from './flows.service';
import { FLOW_QUEUE } from '../queue/queue.module';
import { FlowDefinition, FlowRunResult } from './types';

interface FlowJobData {
  flowId: string;
  projectId: string;
  payload: Record<string, unknown>;
  flow: FlowDefinition;
}

@Processor(FLOW_QUEUE, { concurrency: 4, lockDuration: 2 * 60_000 })
export class FlowExecuteProcessor extends WorkerHost {
  private readonly logger = new Logger(FlowExecuteProcessor.name);

  constructor(private readonly flowsService: FlowsService) {
    super();
  }

  async process(job: Job<FlowJobData, FlowRunResult>): Promise<FlowRunResult> {
    this.logger.log(`Flow job ${job.id}: flow=${job.data.flowId}`);
    const result = await this.flowsService.executeFlow(job.data.flow, job.data.payload);
    if (!result.success) {
      this.logger.warn(`Flow ${job.data.flowId} completed with errors: ${result.errors.join('; ')}`);
    }
    return result;
  }
}
