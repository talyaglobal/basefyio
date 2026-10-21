import { AuditEvent } from './audit-event';
import { AuditSinkService } from './audit-sink.service';
import { AuditTarget, NonRetryableAuditError } from './targets/audit-target';

function event(n: number): AuditEvent {
  return {
    time: '2026-10-20T10:00:00.000Z',
    source: 'http',
    traceId: `t${n}`,
    actorUserId: 'u1',
    actorRole: 'USER',
    action: `GET /api/x/${n}`,
    resourceType: 'x',
    resourceId: null,
    severity: 'LOW',
    success: true,
    host: 'api-1',
    env: 'test',
    product: 'basefyio',
  };
}

class FakeTarget implements AuditTarget {
  readonly name = 'fake';
  readonly description = 'fake://';
  readonly batches: AuditEvent[][] = [];
  failures: Array<Error | null> = [];
  closed = false;
  async send(batch: AuditEvent[]) {
    const next = this.failures.shift();
    if (next) throw next;
    this.batches.push(batch);
  }
  async close() {
    this.closed = true;
  }
}

/** A service whose retry sleeps resolve immediately. */
class FastSink extends AuditSinkService {
  protected sleep(): Promise<void> {
    return Promise.resolve();
  }
}

const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] }) as any;
const enabledEnv = (extra: Record<string, string> = {}) =>
  env({ AUDIT_FORWARD_URL: 'https://siem.example/ingest', ...extra });

describe('AuditSinkService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is inert when nothing is configured: no targets, no timer, enqueue is a no-op', () => {
    jest.useFakeTimers();
    const sink = new AuditSinkService(env({}));
    expect(sink.enabled).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    sink.enqueue(event(1));
    expect(sink.stats()).toMatchObject({
      enabled: false,
      queue: { depth: 0 },
      counters: { enqueued: 0, dropped: 0 },
    });
  });

  it('reports a bad webhook URL as a problem instead of enabling a broken target', () => {
    const sink = new AuditSinkService(env({ AUDIT_FORWARD_URL: 'http://plain.example/x' }));
    expect(sink.enabled).toBe(false);
    expect(sink.problems[0]).toMatch(/https/);
  });

  it('delivers a batch on flush and counts it', async () => {
    const target = new FakeTarget();
    const sink = new FastSink(enabledEnv(), [target]);
    sink.enqueue(event(1));
    sink.enqueue(event(2));
    await sink.flush();
    expect(target.batches).toEqual([[event(1), event(2)]]);
    expect(sink.stats().targets[0]).toMatchObject({ sent: 2, failed: 0, inFlight: false });
    expect(sink.stats().targets[0].lastSuccessAt).not.toBeNull();
    await sink.onModuleDestroy();
  });

  it('flushes on its own once the queue reaches the batch size', async () => {
    const target = new FakeTarget();
    const sink = new FastSink(enabledEnv({ AUDIT_BATCH_SIZE: '2' }), [target]);
    sink.enqueue(event(1));
    sink.enqueue(event(2));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(target.batches).toHaveLength(1);
    await sink.onModuleDestroy();
  });

  it('drops the oldest event beyond the queue cap and counts the drop', async () => {
    const target = new FakeTarget();
    const sink = new FastSink(enabledEnv({ AUDIT_QUEUE_MAX: '100', AUDIT_BATCH_SIZE: '1000' }), [target]);
    for (let i = 1; i <= 103; i++) sink.enqueue(event(i));
    expect(sink.stats().queue.depth).toBe(100);
    expect(sink.stats().counters).toEqual({ enqueued: 103, dropped: 3 });
    await sink.flush();
    expect(target.batches[0][0].traceId).toBe('t4');
    await sink.onModuleDestroy();
  });

  it('retries a failing batch and then gives up, recording the error', async () => {
    const target = new FakeTarget();
    target.failures = [new Error('boom 1'), new Error('boom 2'), new Error('boom 3'), new Error('boom 4')];
    const sink = new FastSink(enabledEnv({ AUDIT_RETRIES: '3' }), [target]);
    sink.enqueue(event(1));
    await sink.flush();
    expect(target.batches).toHaveLength(0);
    expect(sink.stats().targets[0]).toMatchObject({ sent: 0, failed: 1 });
    expect(sink.stats().targets[0].lastError?.message).toBe('boom 4');
    await sink.onModuleDestroy();
  });

  it('does not retry a non-retryable failure', async () => {
    const target = new FakeTarget();
    const spy = jest.spyOn(target, 'send');
    target.failures = [new NonRetryableAuditError('401')];
    const sink = new FastSink(enabledEnv({ AUDIT_RETRIES: '3' }), [target]);
    sink.enqueue(event(1));
    await sink.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sink.stats().targets[0].failed).toBe(1);
    await sink.onModuleDestroy();
  });

  it('keeps a transient failure from touching the next batch', async () => {
    const target = new FakeTarget();
    target.failures = [new Error('once')];
    const sink = new FastSink(enabledEnv({ AUDIT_RETRIES: '1' }), [target]);
    sink.enqueue(event(1));
    await sink.flush();
    sink.enqueue(event(2));
    await sink.flush();
    expect(target.batches).toEqual([[event(1)], [event(2)]]);
    await sink.onModuleDestroy();
  });

  it('a target that throws synchronously never reaches the caller of enqueue', async () => {
    const target: AuditTarget = {
      name: 'bad',
      description: 'bad://',
      send: () => {
        throw new Error('sync explosion');
      },
      close: async () => undefined,
    };
    const sink = new FastSink(enabledEnv({ AUDIT_RETRIES: '0' }), [target]);
    expect(() => sink.enqueue(event(1))).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(sink.stats().targets[0].failed).toBe(1);
    await sink.onModuleDestroy();
  });

  it('redacts nothing it was not given and reports the queue bounds', () => {
    const sink = new FastSink(enabledEnv({ AUDIT_QUEUE_MAX: '500', AUDIT_BATCH_SIZE: '50' }), [new FakeTarget()]);
    expect(sink.stats()).toMatchObject({ enabled: true, queue: { depth: 0, max: 500 }, batchSize: 50 });
  });

  it('sendTestEvent reports delivery per target', async () => {
    const good = new FakeTarget();
    const bad = new FakeTarget();
    bad.failures = [new NonRetryableAuditError('403')];
    const sink = new FastSink(enabledEnv(), [good, bad]);
    const result = await sink.sendTestEvent({ ...event(9), source: 'test' });
    expect(result.ok).toBe(false);
    expect(result.targets).toEqual([
      { name: 'fake', ok: true, error: null },
      { name: 'fake', ok: false, error: '403' },
    ]);
    await sink.onModuleDestroy();
  });

  it('drains what it can on shutdown and closes every target', async () => {
    const target = new FakeTarget();
    const sink = new FastSink(enabledEnv({ AUDIT_BATCH_SIZE: '1000' }), [target]);
    sink.enqueue(event(1));
    await sink.onModuleDestroy();
    expect(target.batches).toEqual([[event(1)]]);
    expect(target.closed).toBe(true);
    // After shutdown nothing is accepted.
    sink.enqueue(event(2));
    expect(sink.stats().queue.depth).toBe(0);
  });
});
