import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PitrRestoreJobsService, pitrLimits } from './pitr-restore-jobs.service';
import { PitrRestoreError } from './project-pitr.service';

const PROJECT = {
  id: 'p1',
  teamId: 't1',
  name: 'demo',
  dbName: 'db_p1',
  dbUser: 'u_p1',
  dbPassword: 'pw',
  dbHost: 'postgres',
  dbPort: 5432,
  databaseType: 'RELATIONAL',
};

function jobRow(over: Partial<Record<string, any>> = {}) {
  return {
    id: 'j1',
    projectId: 'p1',
    requestedBy: 'u1',
    targetTime: new Date('2026-11-20T10:00:00.000Z'),
    status: 'queued',
    phase: 'waiting',
    message: 'Waiting for a free restore slot',
    method: null,
    exact: null,
    restoredTo: null,
    runId: null,
    createdAt: new Date('2026-11-20T11:00:00.000Z'),
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function build() {
  const jobs = {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation(({ data }) => Promise.resolve(jobRow(data))),
    update: jest.fn().mockImplementation(({ data }) => Promise.resolve(jobRow(data))),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const prisma: any = {
    pitrRestoreJob: jobs,
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));
  const pitr = {
    loadProjectForMember: jest.fn().mockResolvedValue(PROJECT),
    loadProject: jest.fn().mockResolvedValue(PROJECT),
    validateRestoreTarget: jest.fn().mockResolvedValue(new Date('2026-11-20T10:00:00.000Z')),
    executeRestore: jest.fn().mockResolvedValue({
      method: 'wal-replay',
      restoredTo: '2026-11-20T10:00:00.000Z',
      exact: true,
      message: 'Database recovered to the requested point in time',
    }),
    cleanupRun: jest.fn().mockResolvedValue(undefined),
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const alerts = { raise: jest.fn().mockResolvedValue(undefined) };
  const svc = new PitrRestoreJobsService(prisma, pitr as any, activity as any, alerts as any);
  // Keep the background pump out of the request tests.
  const pump = jest.spyOn(svc, 'pump').mockResolvedValue(undefined);
  return { svc, prisma, jobs, pitr, activity, alerts, pump };
}

const ENV_KEYS = [
  'PITR_RESTORE_ENABLED',
  'PITR_RESTORE_MAX_CONCURRENT',
  'PITR_RESTORE_MAX_QUEUED',
  'PITR_RESTORE_MAX_PER_HOUR',
  'PITR_RESTORE_TIMEOUT_MINUTES',
];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  jest.useRealTimers();
});

describe('PitrRestoreJobsService.start', () => {
  it('queues a job under the advisory lock and answers at once with its id', async () => {
    const { svc, prisma, jobs, pump } = build();
    const view = await svc.start('p1', 'u1', '2026-11-20T10:00:00.000Z');

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringMatching(/^SELECT pg_advisory_xact_lock\(\d+\)$/));
    expect(jobs.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: 'p1', requestedBy: 'u1', status: 'queued', phase: 'waiting' }),
    });
    expect(view).toEqual(
      expect.objectContaining({ jobId: 'j1', status: 'queued', targetTime: '2026-11-20T10:00:00.000Z' }),
    );
    expect(view).not.toHaveProperty('error');
    expect(pump).toHaveBeenCalled();
  });

  it('refuses a second restore for the same project with 409 and the active job id', async () => {
    const { svc, jobs } = build();
    jobs.findFirst.mockResolvedValueOnce(jobRow({ id: 'active-1', status: 'running' }));
    const err = await svc.start('p1', 'u1', '2026-11-20T10:00:00.000Z').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ details: { jobId: 'active-1' } }),
    );
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('rate-limits a project to PITR_RESTORE_MAX_PER_HOUR requests (429)', async () => {
    process.env.PITR_RESTORE_MAX_PER_HOUR = '2';
    const { svc, jobs } = build();
    jobs.count.mockResolvedValueOnce(2);
    const err = await svc.start('p1', 'u1', '2026-11-20T10:00:00.000Z').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('refuses when the cluster-wide queue is full (503)', async () => {
    process.env.PITR_RESTORE_MAX_QUEUED = '1';
    const { svc, jobs } = build();
    jobs.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(svc.start('p1', 'u1', '2026-11-20T10:00:00.000Z')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('refuses every new restore when PITR_RESTORE_ENABLED=false', async () => {
    process.env.PITR_RESTORE_ENABLED = 'false';
    const { svc, jobs, pitr } = build();
    await expect(svc.start('p1', 'u1', '2026-11-20T10:00:00.000Z')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(pitr.validateRestoreTarget).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('passes validation errors through as 400 without creating a job', async () => {
    const { svc, jobs, pitr } = build();
    pitr.validateRestoreTarget.mockRejectedValueOnce(new BadRequestException('targetTime cannot be in the future'));
    await expect(svc.start('p1', 'u1', '2999-01-01T00:00:00Z')).rejects.toBeInstanceOf(BadRequestException);
    expect(jobs.create).not.toHaveBeenCalled();
  });
});

describe('PitrRestoreJobsService.claimNext', () => {
  it('claims nothing while the cluster-wide cap is reached', async () => {
    const { svc, jobs } = build();
    jobs.count.mockResolvedValueOnce(1);
    expect(await svc.claimNext()).toBeNull();
    expect(jobs.update).not.toHaveBeenCalled();
  });

  it('claims the oldest queued job and marks it running with a heartbeat', async () => {
    const { svc, jobs, prisma } = build();
    jobs.findFirst.mockResolvedValueOnce(jobRow());
    const claimed = await svc.claimNext();
    expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
    expect(jobs.findFirst).toHaveBeenCalledWith({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } });
    expect(jobs.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: expect.objectContaining({ status: 'running', heartbeatAt: expect.any(Date) }),
    });
    expect(claimed?.status).toBe('running');
  });

  it('claims nothing while restores are switched off', async () => {
    process.env.PITR_RESTORE_ENABLED = 'off';
    const { svc, prisma } = build();
    expect(await svc.claimNext()).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PitrRestoreJobsService.reapStale', () => {
  it('fails a running job whose heartbeat went quiet and cleans up its scratch', async () => {
    const { svc, jobs, pitr } = build();
    jobs.findMany.mockResolvedValueOnce([jobRow({ status: 'running', phase: 'replaying', runId: 'abcd1234' })]);
    await svc.reapStale();
    expect(jobs.updateMany).toHaveBeenCalledWith({
      where: { id: 'j1', status: 'running' },
      data: expect.objectContaining({
        status: 'failed',
        message: expect.stringContaining('Your database was not changed'),
      }),
    });
    expect(pitr.cleanupRun).toHaveBeenCalledWith('abcd1234');
  });

  it('says so when the interrupted job had started writing', async () => {
    const { svc, jobs } = build();
    jobs.findMany.mockResolvedValueOnce([jobRow({ status: 'running', phase: 'restoring' })]);
    await svc.reapStale();
    expect(jobs.updateMany.mock.calls[0][0].data.message).toMatch(/Writing into your database had started/);
  });

  it('cancels a job that waited past the queue limit', async () => {
    const { svc, jobs } = build();
    jobs.findMany.mockResolvedValueOnce([jobRow({ status: 'queued' })]);
    await svc.reapStale();
    expect(jobs.updateMany.mock.calls[0][0].data.message).toMatch(/waited too long/);
  });
});

describe('PitrRestoreJobsService.run', () => {
  it('records success with the method and the instant reached', async () => {
    const { svc, jobs, pitr } = build();
    await svc.run(jobRow({ status: 'running' }));
    expect(pitr.executeRestore).toHaveBeenCalledWith(
      PROJECT,
      new Date('2026-11-20T10:00:00.000Z'),
      'u1',
      expect.objectContaining({ signal: expect.any(Object), phase: expect.any(Function) }),
    );
    expect(jobs.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: expect.objectContaining({ status: 'succeeded', method: 'wal-replay', exact: true }),
    });
  });

  it('reports progress through the phase callback', async () => {
    const { svc, jobs, pitr } = build();
    pitr.executeRestore.mockImplementationOnce(async (_p: any, _t: any, _u: any, ctx: any) => {
      await ctx.phase('replaying', 'Replaying the change log up to the requested time');
      return { method: 'wal-replay', restoredTo: '2026-11-20T10:00:00.000Z', exact: true, message: 'ok' };
    });
    await svc.run(jobRow({ status: 'running' }));
    expect(jobs.updateMany).toHaveBeenCalledWith({
      where: { id: 'j1', status: 'running' },
      data: expect.objectContaining({ phase: 'replaying' }),
    });
  });

  it('records a failure with the user message, keeps the detail internal, logs activity and alerts', async () => {
    const { svc, jobs, pitr, activity, alerts } = build();
    pitr.executeRestore.mockRejectedValueOnce(
      new PitrRestoreError('Replay failed. Your database was not changed.', 'postgres log tail …', true),
    );
    await svc.run(jobRow({ status: 'running' }));
    expect(jobs.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: expect.objectContaining({
        status: 'failed',
        message: 'Replay failed. Your database was not changed.',
        error: 'postgres log tail …',
      }),
    });
    expect(activity.append).toHaveBeenCalledWith('p1', expect.objectContaining({ kind: 'project.pitr_failed' }));
    expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pitr_restore_failed' }));
  });

  it('stops a run at the hard deadline and fails it with a clear message', async () => {
    process.env.PITR_RESTORE_TIMEOUT_MINUTES = '1';
    jest.useFakeTimers();
    const { svc, jobs, pitr } = build();
    pitr.executeRestore.mockImplementationOnce(
      (_p: any, _t: any, _u: any, ctx: any) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
        }),
    );
    const done = svc.run(jobRow({ status: 'running' }));
    await jest.advanceTimersByTimeAsync(61_000);
    await done;
    expect(jobs.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: expect.objectContaining({
        status: 'failed',
        message: expect.stringMatching(/did not finish within 1 minutes.*not changed/),
      }),
    });
  });

  it('fails when the project was deleted while the job waited', async () => {
    const { svc, jobs, pitr } = build();
    pitr.loadProject.mockResolvedValueOnce(null);
    await svc.run(jobRow({ status: 'running' }));
    expect(pitr.executeRestore).not.toHaveBeenCalled();
    expect(jobs.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: 'failed', message: 'The project no longer exists.' }),
    );
  });
});

describe('PitrRestoreJobsService views', () => {
  it('reports the queue position of a waiting job', async () => {
    const { svc, jobs } = build();
    jobs.findFirst.mockResolvedValueOnce(jobRow());
    jobs.count.mockResolvedValueOnce(2);
    const view = await svc.get('p1', 'j1', 'u1');
    expect(view.queuePosition).toBe(3);
  });

  it('latest answers null when the project never restored', async () => {
    const { svc } = build();
    expect(await svc.latest('p1', 'u1')).toEqual({ job: null });
  });
});

describe('describeFailure', () => {
  it('never claims the database is untouched for an unknown failure while writing', () => {
    const { svc } = build();
    const out = svc.describeFailure(new Error('boom'), 'restoring', 60_000);
    expect(out.message).not.toMatch(/not changed/);
    expect(out.alert).toBe(true);
  });

  it('passes an HttpException message through (e.g. the scratch-space refusal)', () => {
    const { svc } = build();
    const out = svc.describeFailure(new ServiceUnavailableException('temporarily unavailable'), 'preparing', 60_000);
    expect(out.message).toBe('temporarily unavailable');
  });
});

describe('pitrLimits', () => {
  it('defaults to one running restore, five waiting, three per project per hour', () => {
    expect(pitrLimits()).toEqual(
      expect.objectContaining({ enabled: true, maxConcurrent: 1, maxQueued: 5, maxPerHour: 3 }),
    );
  });
});
