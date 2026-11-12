jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../projects/public-api.service', () => ({ PublicApiService: class {} }));
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FlowSchedulerService } from './flow-scheduler.service';

type FlowRow = { id: string; projectId: string; trigger: unknown; updatedAt: Date };

function build(opts: {
  flows: FlowRow[];
  projects?: string[];
  entitled?: boolean;
  waiting?: number;
  createRun?: jest.Mock;
}) {
  const prisma = {
    flow: { findMany: jest.fn().mockResolvedValue(opts.flows) },
    project: {
      findMany: jest.fn().mockResolvedValue((opts.projects ?? opts.flows.map((f) => f.projectId)).map((id) => ({ id }))),
    },
    flowRun: { count: jest.fn().mockResolvedValue(opts.waiting ?? 0) },
  };
  const createRun = opts.createRun ?? jest.fn().mockImplementation(async () => ({ id: 'run' }));
  const flows = { createRun, failAbandonedRuns: jest.fn().mockResolvedValue(0) };
  const entitlement = { can: jest.fn().mockResolvedValue(opts.entitled ?? true) };
  const svc = new FlowSchedulerService(prisma as any, flows as any, entitlement as any);
  return { svc, prisma, createRun, entitlement, flows };
}

const longAgo = new Date('2026-01-01T00:00:00Z');
const flow = (id: string, cron: unknown, extra: Partial<FlowRow> = {}): FlowRow => ({
  id,
  projectId: 'p1',
  trigger: { type: 'schedule', cron },
  updatedAt: longAgo,
  ...extra,
});

describe('FlowSchedulerService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /**
   * A raw timer would fire on every replica. As a registered @Cron job the tick
   * is paused on followers by the cron leader election, like every other job.
   */
  it('is a registered cron job, so the leader election governs it', () => {
    const method = FlowSchedulerService.prototype.onTick;
    expect(Reflect.getMetadata('SCHEDULER_TYPE', method)).toBe(1);
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', method)).toEqual(
      expect.objectContaining({ cronTime: expect.any(String), name: 'flow-schedules' }),
    );
  });

  it('queues a run for a flow whose cron matches the minute, with a per-tick dedupe key', async () => {
    const { svc, createRun } = build({ flows: [flow('f1', '*/1 * * * *')] });
    const created = await svc.tick(new Date('2026-10-22T10:07:03Z'));
    expect(created).toBe(1);
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f1' }),
      expect.objectContaining({
        source: 'schedule',
        dedupeKey: 'schedule:f1:2026-10-22T10:07:00.000Z',
        meta: expect.objectContaining({ scheduledFor: '2026-10-22T10:07:00.000Z' }),
      }),
    );
  });

  it('produces the same dedupe key when two replicas tick the same minute', async () => {
    const a = build({ flows: [flow('f1', '*/5 * * * *')] });
    const b = build({ flows: [flow('f1', '*/5 * * * *')] });
    await a.svc.tick(new Date('2026-10-22T10:05:00.100Z'));
    await b.svc.tick(new Date('2026-10-22T10:05:01.900Z'));
    expect(a.createRun.mock.calls[0][1].dedupeKey).toBe(b.createRun.mock.calls[0][1].dedupeKey);
  });

  it('treats a duplicate (unique-key refusal) as already fired', async () => {
    const createRun = jest.fn().mockResolvedValue(null);
    const { svc } = build({ flows: [flow('f1', '* * * * *')], createRun });
    await expect(svc.tick(new Date('2026-10-22T10:05:00Z'))).resolves.toBe(0);

    const throwing = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5' }),
    );
    const second = build({ flows: [flow('f1', '* * * * *')], createRun: throwing });
    await expect(second.svc.tick(new Date('2026-10-22T10:05:00Z'))).resolves.toBe(0);
  });

  it('recovers a tick missed by a moment (late tick / leader handover) but fires only once', async () => {
    const { svc, createRun } = build({ flows: [flow('f1', '0 * * * *')] });
    // The 10:00 tick was missed; at 10:01 the look-back still finds it.
    await svc.tick(new Date('2026-10-22T10:01:00Z'));
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun.mock.calls[0][1].dedupeKey).toBe('schedule:f1:2026-10-22T10:00:00.000Z');
  });

  it('does not fire for a minute that did not match', async () => {
    const { svc, createRun } = build({ flows: [flow('f1', '0 9 * * *')] });
    await svc.tick(new Date('2026-10-22T10:30:00Z'));
    expect(createRun).not.toHaveBeenCalled();
  });

  it('does not back-fill a tick from before the flow was saved', async () => {
    const { svc, createRun } = build({
      flows: [flow('f1', '0 * * * *', { updatedAt: new Date('2026-10-22T10:00:30Z') })],
    });
    await svc.tick(new Date('2026-10-22T10:01:00Z'));
    expect(createRun).not.toHaveBeenCalled();
  });

  it('skips flows with no or an invalid cron, inactive projects and plans without flows', async () => {
    const none = build({ flows: [flow('f1', undefined), flow('f2', 'not a cron')] });
    await none.svc.tick(new Date('2026-10-22T10:00:00Z'));
    expect(none.createRun).not.toHaveBeenCalled();

    const inactive = build({ flows: [flow('f1', '* * * * *')], projects: [] });
    await inactive.svc.tick(new Date('2026-10-22T10:00:00Z'));
    expect(inactive.createRun).not.toHaveBeenCalled();

    const unentitled = build({ flows: [flow('f1', '* * * * *')], entitled: false });
    await unentitled.svc.tick(new Date('2026-10-22T10:00:00Z'));
    expect(unentitled.createRun).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous scheduled run is still waiting, so no backlog builds up', async () => {
    const { svc, createRun } = build({ flows: [flow('f1', '* * * * *')], waiting: 1 });
    await svc.tick(new Date('2026-10-22T10:00:00Z'));
    expect(createRun).not.toHaveBeenCalled();
  });

  it('reads the cron in the flow time zone', async () => {
    const { svc, createRun } = build({
      flows: [{ ...flow('f1', '0 9 * * *'), trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'Europe/Istanbul' } }],
    });
    await svc.tick(new Date('2026-10-22T06:00:00Z'));
    expect(createRun).toHaveBeenCalledTimes(1);
  });

  it('only asks the database for enabled schedule flows', async () => {
    const { svc, prisma } = build({ flows: [] });
    await svc.tick(new Date());
    expect(prisma.flow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enabled: true, trigger: { path: ['type'], equals: 'schedule' } } }),
    );
  });

  it('never throws out of the cron callback', async () => {
    const { svc, prisma } = build({ flows: [] });
    prisma.flow.findMany.mockRejectedValue(new Error('db down'));
    await expect(svc.onTick()).resolves.toBeUndefined();
  });
});
