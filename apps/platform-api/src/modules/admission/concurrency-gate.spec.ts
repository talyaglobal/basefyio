import { ConcurrencyGate } from './concurrency-gate';

const tick = () => new Promise((r) => setImmediate(r));

describe('ConcurrencyGate', () => {
  it('admits up to maxInflight at once, then queues in order, then sheds when the queue is full', async () => {
    const gate = new ConcurrencyGate({ maxInflight: 2, maxWaiting: 1, maxWaitMs: 1000 });
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect([a.decision, b.decision]).toEqual(['admit', 'admit']);

    const cPromise = gate.acquire(); // queued
    await tick();
    const d = await gate.acquire(); // queue full
    expect(d.decision).toBe('shed_full');
    expect(gate.stats()).toMatchObject({ inflight: 2, waiting: 1, shed: 1 });

    a.release();
    const c = await cPromise;
    expect(c.decision).toBe('queued');
    expect(gate.stats()).toMatchObject({ inflight: 2, waiting: 0 });

    b.release();
    c.release();
    expect(gate.stats().inflight).toBe(0);
  });

  it('sheds a waiter whose wait exceeds maxWaitMs and leaves the queue clean', async () => {
    const gate = new ConcurrencyGate({ maxInflight: 1, maxWaiting: 5, maxWaitMs: 20 });
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(b.decision).toBe('shed_timeout');
    expect(b.waitedMs).toBeGreaterThanOrEqual(15);
    expect(gate.stats()).toMatchObject({ inflight: 1, waiting: 0, shed: 1 });
    a.release();
    expect(gate.stats().inflight).toBe(0);
  });

  it('a release is idempotent and never drives inflight below zero', async () => {
    const gate = new ConcurrencyGate({ maxInflight: 1, maxWaiting: 0, maxWaitMs: 10 });
    const a = await gate.acquire();
    a.release();
    a.release();
    expect(gate.stats().inflight).toBe(0);
    const b = await gate.acquire();
    expect(b.decision).toBe('admit');
    b.release();
  });

  it('wakes waiters in FIFO order', async () => {
    const gate = new ConcurrencyGate({ maxInflight: 1, maxWaiting: 3, maxWaitMs: 1000 });
    const first = await gate.acquire();
    const order: string[] = [];
    const w1 = gate.acquire().then((r) => { order.push('w1'); return r; });
    await tick();
    const w2 = gate.acquire().then((r) => { order.push('w2'); return r; });
    await tick();
    first.release();
    const r1 = await w1;
    r1.release();
    const r2 = await w2;
    r2.release();
    expect(order).toEqual(['w1', 'w2']);
  });
});
