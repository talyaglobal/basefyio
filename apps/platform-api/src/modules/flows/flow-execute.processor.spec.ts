jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../projects/public-api.service', () => ({ PublicApiService: class {} }));
import { Logger } from '@nestjs/common';
import { DelayedError } from 'bullmq';
import { FlowExecuteProcessor, flowWorkerConcurrency } from './flow-execute.processor';
import { FlowConcurrencyService } from './flow-concurrency';

function build(opts: { status?: string; acquire?: boolean; options?: unknown } = {}) {
  const flows = { execute: jest.fn().mockResolvedValue(undefined) };
  const slots = { acquire: jest.fn().mockResolvedValue(opts.acquire ?? true), release: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    flowRun: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'r1',
        projectId: 'p1',
        flowId: 'f1',
        status: opts.status ?? 'queued',
        flow: { options: opts.options ?? null },
      }),
    },
  };
  const proc = new FlowExecuteProcessor(flows as any, slots as any, prisma as any);
  const job = { data: { flowRunId: 'r1' }, moveToDelayed: jest.fn().mockResolvedValue(undefined) };
  return { proc, flows, slots, job };
}

describe('FlowExecuteProcessor', () => {
  afterEach(() => {
    delete process.env.FLOW_WORKER_CONCURRENCY;
    jest.restoreAllMocks();
  });

  it('runs several jobs side by side instead of one serial queue', () => {
    expect(flowWorkerConcurrency()).toBe(10);
    process.env.FLOW_WORKER_CONCURRENCY = '25';
    expect(flowWorkerConcurrency()).toBe(25);
    process.env.FLOW_WORKER_CONCURRENCY = 'nonsense';
    expect(flowWorkerConcurrency()).toBe(10);
  });

  it('executes a run while holding its slot, then releases it', async () => {
    const { proc, flows, slots, job } = build({ options: { maxConcurrentRuns: 2 } });
    await proc.process(job as any, 'token');
    expect(slots.acquire).toHaveBeenCalledWith({ runId: 'r1', projectId: 'p1', flowId: 'f1', flowLimit: 2 });
    expect(flows.execute).toHaveBeenCalledWith('r1');
    expect(slots.release).toHaveBeenCalled();
  });

  it('releases the slot even when execution throws', async () => {
    const { proc, flows, slots, job } = build();
    flows.execute.mockRejectedValue(new Error('boom'));
    await expect(proc.process(job as any, 'token')).rejects.toThrow('boom');
    expect(slots.release).toHaveBeenCalled();
  });

  it('puts the job back for a moment, without using an attempt, when no slot is free', async () => {
    const { proc, flows, job } = build({ acquire: false });
    await expect(proc.process(job as any, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
    expect(flows.execute).not.toHaveBeenCalled();
  });

  it('lets execute settle a run that is no longer queued, without taking a slot', async () => {
    const { proc, flows, slots, job } = build({ status: 'running' });
    await proc.process(job as any, 'token');
    expect(slots.acquire).not.toHaveBeenCalled();
    expect(flows.execute).toHaveBeenCalledWith('r1');
  });
});

describe('FlowConcurrencyService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const svc = (evalImpl: jest.Mock, zrem = jest.fn().mockResolvedValue(1)) =>
    new FlowConcurrencyService({ getClient: () => ({ eval: evalImpl, zrem }) } as any);

  it('asks for the project slot and, when set, the flow slot in one script', async () => {
    const evalMock = jest.fn().mockResolvedValue(1);
    await expect(svc(evalMock).acquire({ runId: 'r1', projectId: 'p1', flowId: 'f1', flowLimit: 1 })).resolves.toBe(true);
    const args = evalMock.mock.calls[0];
    expect(args[1]).toBe(2);
    expect(args[2]).toBe('basefyio:flow-slots:project:p1');
    expect(args[3]).toBe('basefyio:flow-slots:flow:f1');
    expect(args.slice(-2)).toEqual(['5', '1']);
  });

  it('reports a full slot', async () => {
    await expect(svc(jest.fn().mockResolvedValue(0)).acquire({ runId: 'r', projectId: 'p', flowId: 'f' })).resolves.toBe(false);
  });

  it('lets the run go ahead when Redis cannot be asked', async () => {
    await expect(
      svc(jest.fn().mockRejectedValue(new Error('down'))).acquire({ runId: 'r', projectId: 'p', flowId: 'f' }),
    ).resolves.toBe(true);
  });

  it('releases every slot it took', async () => {
    const zrem = jest.fn().mockResolvedValue(1);
    await svc(jest.fn(), zrem).release({ runId: 'r1', projectId: 'p1', flowId: 'f1', flowLimit: 3 });
    expect(zrem).toHaveBeenCalledWith('basefyio:flow-slots:project:p1', 'r1');
    expect(zrem).toHaveBeenCalledWith('basefyio:flow-slots:flow:f1', 'r1');
  });
});
