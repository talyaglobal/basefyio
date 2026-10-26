import { MetricsCollectorService } from './metrics-collector.service';
import { MetricsService } from './metrics.service';

/**
 * The scrape-time gauges come from the platform, are cached between close
 * scrapes, and never make the scrape fail when a source is unreachable.
 */
function build(opts: { dbDown?: boolean } = {}) {
  const metrics = new MetricsService();
  const prisma = {
    project: {
      groupBy: jest.fn().mockResolvedValue([
        { status: 'ACTIVE', _count: { _all: 65 } },
        { status: 'PAUSED', _count: { _all: 206 } },
      ]),
    },
  };
  const health = {
    database: jest.fn().mockResolvedValue({ state: opts.dbDown ? 'failing' : 'ok' }),
    redisCheck: jest.fn().mockResolvedValue({ state: 'ok' }),
  };
  const queue = (waiting: number) => ({
    getJobCounts: jest.fn().mockResolvedValue({ waiting, active: 0, delayed: 0, failed: 0 }),
  });
  const importQueue = queue(3);
  const customerStream = { localSubscriberTotal: () => 4 };
  const svc = new MetricsCollectorService(
    metrics,
    prisma as any,
    health as any,
    customerStream as any,
    importQueue as any,
  );
  return { svc, metrics, prisma, importQueue };
}

describe('MetricsCollectorService', () => {
  it('publishes projects by status, queue depths, connections and dependency reachability', async () => {
    const { svc, metrics } = build();
    await svc.refresh();
    const text = metrics.render();
    expect(text).toMatch(/basefyio_projects\{status="ACTIVE"\} 65/);
    expect(text).toMatch(/basefyio_projects\{status="PAUSED"\} 206/);
    expect(text).toMatch(/basefyio_projects\{status="DELETED"\} 0/);
    expect(text).toMatch(/basefyio_bullmq_jobs\{queue="import",state="waiting"\} 3/);
    expect(text).toMatch(/basefyio_sse_connections\{stream="customer"\} 4/);
    expect(text).toMatch(/basefyio_db_up 1/);
    expect(text).toMatch(/basefyio_redis_up 1/);
  });

  it('reports a dependency that does not answer as 0 instead of failing the scrape', async () => {
    const { svc, metrics } = build({ dbDown: true });
    await svc.refresh();
    expect(metrics.render()).toMatch(/basefyio_db_up 0/);
  });

  it('reuses the last answer for scrapes closer together than ten seconds', async () => {
    const { svc, prisma } = build();
    await svc.refresh();
    await svc.refresh();
    expect(prisma.project.groupBy).toHaveBeenCalledTimes(1);
  });

  it('survives a queue that cannot be asked', async () => {
    const { svc, importQueue, metrics } = build();
    importQueue.getJobCounts.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.refresh()).resolves.toBeUndefined();
    expect(metrics.render()).toMatch(/basefyio_projects\{status="ACTIVE"\}/);
  });
});
