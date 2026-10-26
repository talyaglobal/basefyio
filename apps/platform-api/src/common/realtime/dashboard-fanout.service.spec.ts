import { DashboardFanoutService, DASHBOARD_FANOUT_CHANNEL } from './dashboard-fanout.service';
import { RealtimeStreamService } from './realtime-stream.service';

/**
 * An event published on one replica reaches the connections held by the
 * others, exactly once, and a replica never redelivers what it published.
 */
function fakeRedis() {
  const published: Array<{ channel: string; raw: string }> = [];
  const handlers: Array<(channel: string, raw: string) => void> = [];
  const sub = {
    on: (ev: string, fn: any) => {
      if (ev === 'message') handlers.push(fn);
    },
    subscribe: async () => undefined,
    disconnect: () => undefined,
  };
  const redis = {
    isReady: () => true,
    publish: async (channel: string, raw: string) => {
      published.push({ channel, raw });
      return 1;
    },
    createSubscriber: () => sub,
  };
  return { redis: redis as any, published, deliver: (raw: string) => handlers.forEach((h) => h(DASHBOARD_FANOUT_CHANNEL, raw)) };
}

function stream() {
  const writes: string[] = [];
  const res = { write: (s: string) => void writes.push(s) } as any;
  const svc = new RealtimeStreamService();
  const id = svc.subscribe('u1', ['team:t1'], res);
  return { svc, id, writes };
}

const event = (id: string) =>
  ({ eventId: id, traceId: 't', emittedAt: 'now', feature: 'realtime_phase1', entityType: 'project', action: 'created', entityId: 'p', teamId: 't1' }) as any;

describe('DashboardFanoutService', () => {
  afterEach(() => RealtimeStreamService.setFanout(null));

  it('delivers locally and publishes to Redis with its own origin', () => {
    const { redis, published } = fakeRedis();
    const fanout = new DashboardFanoutService(redis, { get: () => undefined } as any);
    fanout.onModuleInit();
    const { svc, id, writes } = stream();

    svc.publish(event('e1'));

    expect(writes.join('')).toContain('"eventId":"e1"');
    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0].raw)).toMatchObject({ v: 1, event: { eventId: 'e1' } });
    svc.unsubscribe(id);
  });

  it('ignores its own messages when they come back from Redis', () => {
    const { redis, published, deliver } = fakeRedis();
    const fanout = new DashboardFanoutService(redis, { get: () => undefined } as any);
    fanout.onModuleInit();
    const { svc, id, writes } = stream();

    svc.publish(event('e1'));
    deliver(published[0].raw);

    expect(writes.join('').match(/"eventId":"e1"/g)).toHaveLength(1);
    svc.unsubscribe(id);
  });

  it('delivers a sibling replica\'s message to local connections', () => {
    const { redis, deliver } = fakeRedis();
    const fanout = new DashboardFanoutService(redis, { get: () => undefined } as any);
    fanout.onModuleInit();
    const { svc, id, writes } = stream();

    deliver(JSON.stringify({ v: 1, origin: 'sibling-1', event: event('e2') }));

    expect(writes.join('')).toContain('"eventId":"e2"');
    svc.unsubscribe(id);
  });

  it('stays local when fan-out is switched off', () => {
    const { redis, published } = fakeRedis();
    const fanout = new DashboardFanoutService(redis, { get: (k: string) => (k === 'REALTIME_FANOUT' ? 'off' : undefined) } as any);
    fanout.onModuleInit();
    const { svc, id, writes } = stream();

    svc.publish(event('e3'));

    expect(writes.join('')).toContain('"eventId":"e3"');
    expect(published).toHaveLength(0);
    svc.unsubscribe(id);
  });
});
