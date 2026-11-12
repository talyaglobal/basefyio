import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { FLOW_QUEUE } from '../queue/queue.module';
import { FlowsService } from './flows.service';
import { FlowConcurrencyService } from './flow-concurrency';
import { readStoredOptions } from './flow-definition';

interface FlowJobData {
  flowRunId: string;
}

/** Runs one replica executes at the same time (all projects together). */
export function flowWorkerConcurrency(): number {
  const n = Number.parseInt(process.env.FLOW_WORKER_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10;
}

/** How long a run that found no free slot waits before it asks again. */
export const SLOT_RETRY_MS = 2_000;

/**
 * The FLOW_QUEUE worker.
 *
 * It used to process one job at a time, so every flow of every project waited
 * behind whichever run was in progress — a slow HTTP call in one project
 * delayed everybody's automations. Now a replica runs up to
 * FLOW_WORKER_CONCURRENCY runs side by side, and each run first takes a slot
 * from its project's limit (FLOW_PROJECT_MAX_CONCURRENCY) and, if the flow sets
 * one, from the flow's own `options.maxConcurrentRuns`. A run that finds no
 * free slot goes back to the queue's delayed set for a moment without using up
 * an attempt, leaving the worker free for other projects' runs.
 */
@Processor(FLOW_QUEUE)
export class FlowExecuteProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(FlowExecuteProcessor.name);

  constructor(
    private readonly flows: FlowsService,
    private readonly slots: FlowConcurrencyService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    try {
      this.worker.concurrency = flowWorkerConcurrency();
    } catch (err: any) {
      this.logger.warn(`Could not set flow worker concurrency: ${err?.message}`);
    }
  }

  async process(job: Job<FlowJobData>, token?: string): Promise<void> {
    const flowRunId = job.data?.flowRunId;
    if (!flowRunId) return;
    const run = await this.prisma.flowRun.findUnique({
      where: { id: flowRunId },
      select: { id: true, projectId: true, flowId: true, status: true, flow: { select: { options: true } } },
    });
    if (!run) return;
    // Only a queued run takes a slot; anything else is settled by execute().
    if (run.status !== 'queued') {
      await this.flows.execute(flowRunId);
      return;
    }
    const slot = {
      runId: run.id,
      projectId: run.projectId,
      flowId: run.flowId,
      flowLimit: readStoredOptions(run.flow?.options).maxConcurrentRuns,
    };
    if (!(await this.slots.acquire(slot))) {
      await job.moveToDelayed(Date.now() + SLOT_RETRY_MS, token);
      throw new DelayedError();
    }
    try {
      await this.flows.execute(flowRunId);
    } finally {
      await this.slots.release(slot);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<FlowJobData>, err: Error) {
    this.logger.warn(`flow run ${job?.data?.flowRunId} failed: ${err?.message}`);
  }
}
