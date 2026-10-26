import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from './metrics.service';
import { HealthService } from './health.service';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';
import { RealtimeFanoutService } from '../../modules/realtime-data/realtime-fanout.service';
import {
  BILLING_QUEUE,
  DATA_IMPORT_QUEUE,
  EMAIL_QUEUE,
  EMBEDDING_QUEUE,
  EXPORT_QUEUE,
  FLOW_QUEUE,
  IMPORT_QUEUE,
  RAG_INDEX_QUEUE,
  TENANT_EMBEDDING_QUEUE,
} from '../queue/queue.module';

/** Scrapes closer together than this reuse the last answer. */
const REFRESH_INTERVAL_MS = 10_000;

/**
 * Gauges that describe the platform, not this process: how many projects
 * are active or deactivated, how deep each queue is, how many realtime
 * connections this replica holds, whether the database and Redis answer.
 * Read when a scrape asks, never on a timer, and cached for ten seconds so
 * a busy Prometheus cannot turn the scrape into load.
 */
@Injectable()
export class MetricsCollectorService {
  private readonly logger = new Logger(MetricsCollectorService.name);
  private lastRefreshAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
    @Optional() private readonly customerStream?: RealtimeFanoutService,
    @Optional() @InjectQueue(IMPORT_QUEUE) private readonly importQueue?: Queue,
    @Optional() @InjectQueue(EMAIL_QUEUE) private readonly emailQueue?: Queue,
    @Optional() @InjectQueue(EXPORT_QUEUE) private readonly exportQueue?: Queue,
    @Optional() @InjectQueue(BILLING_QUEUE) private readonly billingQueue?: Queue,
    @Optional() @InjectQueue(DATA_IMPORT_QUEUE) private readonly dataImportQueue?: Queue,
    @Optional() @InjectQueue(EMBEDDING_QUEUE) private readonly embeddingQueue?: Queue,
    @Optional() @InjectQueue(RAG_INDEX_QUEUE) private readonly ragIndexQueue?: Queue,
    @Optional() @InjectQueue(TENANT_EMBEDDING_QUEUE) private readonly tenantEmbeddingQueue?: Queue,
    @Optional() @InjectQueue(FLOW_QUEUE) private readonly flowQueue?: Queue,
  ) {}

  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (Date.now() - this.lastRefreshAt < REFRESH_INTERVAL_MS) return;
    this.inflight = this.collect()
      .catch((err: any) => this.logger.debug(`metrics collection failed: ${err?.message ?? err}`))
      .finally(() => {
        this.lastRefreshAt = Date.now();
        this.inflight = null;
      });
    return this.inflight;
  }

  private async collect(): Promise<void> {
    await Promise.all([this.projects(), this.queues(), this.dependencies()]);
    this.connections();
  }

  private async projects(): Promise<void> {
    const rows = await this.prisma.project.groupBy({ by: ['status'], _count: { _all: true } });
    for (const status of ['ACTIVE', 'PAUSED', 'DEACTIVATED', 'DELETED']) {
      const row = rows.find((r) => r.status === status);
      this.metrics.setGauge(
        'basefyio_projects',
        'Projects by status. PAUSED is the deactivated state.',
        `status="${status}"`,
        row?._count._all ?? 0,
      );
    }
  }

  private async queues(): Promise<void> {
    const queues: Array<[string, Queue | undefined]> = [
      [IMPORT_QUEUE, this.importQueue],
      [EMAIL_QUEUE, this.emailQueue],
      [EXPORT_QUEUE, this.exportQueue],
      [BILLING_QUEUE, this.billingQueue],
      [DATA_IMPORT_QUEUE, this.dataImportQueue],
      [EMBEDDING_QUEUE, this.embeddingQueue],
      [RAG_INDEX_QUEUE, this.ragIndexQueue],
      [TENANT_EMBEDDING_QUEUE, this.tenantEmbeddingQueue],
      [FLOW_QUEUE, this.flowQueue],
    ];
    await Promise.all(
      queues.map(async ([name, queue]) => {
        if (!queue) return;
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
          this.metrics.setGauge(
            'basefyio_bullmq_jobs',
            'Jobs per queue and state.',
            `queue="${name}",state="${state}"`,
            counts[state] ?? 0,
          );
        }
      }),
    );
  }

  private async dependencies(): Promise<void> {
    const [db, redis] = await Promise.all([this.health.database(), this.health.redisCheck()]);
    this.metrics.setGauge('basefyio_db_up', 'Whether the platform database answered within a second.', '', db.state === 'ok' ? 1 : 0);
    this.metrics.setGauge('basefyio_redis_up', 'Whether Redis answered within a second.', '', redis.state === 'ok' ? 1 : 0);
  }

  private connections(): void {
    this.metrics.setGauge(
      'basefyio_sse_connections',
      'Realtime connections held by this process, by stream.',
      'stream="dashboard"',
      RealtimeStreamService.localConnectionCount(),
    );
    this.metrics.setGauge(
      'basefyio_sse_connections',
      'Realtime connections held by this process, by stream.',
      'stream="customer"',
      this.customerStream?.localSubscriberTotal() ?? 0,
    );
  }
}
