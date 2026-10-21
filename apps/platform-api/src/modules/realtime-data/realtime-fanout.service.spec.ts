import { RealtimeFanoutService } from './realtime-fanout.service';
import type { FanoutMessage } from './realtime-data.types';

/**
 * One message, one delivery per subscriber, however many API instances run.
 *
 * The publishing instance delivers locally and tags the message with its own
 * id; every instance drops what carries its own id and delivers the rest. So a
 * single instance behaves as it did before Redis was in the path, and a second
 * instance receives each message exactly once.
 */
function makeRedis(ready = true) {
  const subscriber = {
    on: jest.fn(),
    subscribe: jest.fn().mockResolvedValue(1),
    unsubscribe: jest.fn().mockResolvedValue(0),
    disconnect: jest.fn(),
  };
  const client = { pubsub: jest.fn().mockResolvedValue(['rt:p1', 1]) };
  const redis = {
    isReady: jest.fn(() => ready),
    publish: jest.fn().mockResolvedValue(1),
    createSubscriber: jest.fn(() => subscriber),
    getClient: jest.fn(() => client),
  };
  return { redis, subscriber, client };
}

const configOf = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as any;

function build(env?: Record<string, string>, ready = true) {
  const r = makeRedis(ready);
  const svc = new RealtimeFanoutService(r.redis as any, configOf(env));
  const delivered: FanoutMessage[] = [];
  svc.setLocalDeliverer((m) => delivered.push(m));
  svc.onModuleInit();
  return { svc, delivered, ...r };
}

const msg = (over: Partial<FanoutMessage> = {}) => ({
  kind: 'data_change' as const,
  projectId: 'p1',
  channel: 'table:orders',
  event: { eventId: 'e1' },
  ...over,
});

describe('RealtimeFanoutService', () => {
  afterEach(() => jest.useRealTimers());

  it('delivers locally once and publishes to the project channel with its own origin', () => {
    const { svc, delivered, redis } = build();
    svc.publish(msg());
    expect(delivered).toHaveLength(1);
    expect(delivered[0].origin).toBe(svc.instanceId);
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = redis.publish.mock.calls[0];
    expect(channel).toBe('rt:p1');
    expect(JSON.parse(raw)).toMatchObject({ v: 1, origin: svc.instanceId, channel: 'table:orders' });
  });

  it('drops a message that carries its own origin — it was delivered locally already', () => {
    const { svc, delivered } = build();
    svc.handleRemoteMessage(JSON.stringify({ ...msg(), v: 1, origin: svc.instanceId }));
    expect(delivered).toHaveLength(0);
  });

  it('delivers a message from another instance exactly once', () => {
    const { svc, delivered } = build();
    svc.handleRemoteMessage(JSON.stringify({ ...msg(), v: 1, origin: 'other-instance' }));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].origin).toBe('other-instance');
  });

  it('ignores malformed or foreign-shaped messages', () => {
    const { svc, delivered } = build();
    svc.handleRemoteMessage('not json');
    svc.handleRemoteMessage(JSON.stringify({ v: 2, origin: 'x', projectId: 'p1' }));
    svc.handleRemoteMessage(JSON.stringify({ v: 1, origin: 'x' }));
    expect(delivered).toHaveLength(0);
  });

  it('subscribes to the project channel on the first local subscriber and unsubscribes after the last', () => {
    const { svc, subscriber } = build();
    svc.onLocalSubscriberAdded('p1');
    svc.onLocalSubscriberAdded('p1');
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledWith('rt:p1');
    svc.onLocalSubscriberRemoved('p1');
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    svc.onLocalSubscriberRemoved('p1');
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('rt:p1');
    expect(svc.localSubscriberCount('p1')).toBe(0);
  });

  it('answers hasAnySubscribers from the local count without asking Redis', async () => {
    const { svc, client } = build();
    svc.onLocalSubscriberAdded('p1');
    await expect(svc.hasAnySubscribers('p1')).resolves.toBe(true);
    expect(client.pubsub).not.toHaveBeenCalled();
  });

  it('asks Redis how many listen when nobody is local, and caches the answer briefly', async () => {
    const { svc, client } = build();
    await expect(svc.hasAnySubscribers('p1')).resolves.toBe(true);
    await expect(svc.hasAnySubscribers('p1')).resolves.toBe(true);
    expect(client.pubsub).toHaveBeenCalledTimes(1);
    expect(client.pubsub).toHaveBeenCalledWith('NUMSUB', 'rt:p1');
  });

  it('reports no remote interest when NUMSUB is zero or fails', async () => {
    const { svc, client } = build();
    client.pubsub.mockResolvedValueOnce(['rt:p2', 0]);
    await expect(svc.hasAnySubscribers('p2')).resolves.toBe(false);
    client.pubsub.mockRejectedValueOnce(new Error('down'));
    await expect(svc.hasAnySubscribers('p3')).resolves.toBe(false);
  });

  it('with REALTIME_FANOUT=off never opens a subscriber connection or publishes, yet delivers locally', async () => {
    const { svc, delivered, redis, client } = build({ REALTIME_FANOUT: 'off' });
    expect(redis.createSubscriber).not.toHaveBeenCalled();
    svc.onLocalSubscriberAdded('p1');
    svc.publish(msg());
    expect(delivered).toHaveLength(1);
    expect(redis.publish).not.toHaveBeenCalled();
    await expect(svc.hasAnySubscribers('p9')).resolves.toBe(false);
    expect(client.pubsub).not.toHaveBeenCalled();
    expect(svc.isEnabled()).toBe(false);
  });

  it('skips Redis while it is not ready, and still delivers locally', () => {
    const { svc, delivered, redis } = build(undefined, false);
    svc.publish(msg());
    expect(delivered).toHaveLength(1);
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('swallows a failing publish — local delivery already happened', async () => {
    const { svc, delivered, redis } = build();
    redis.publish.mockRejectedValueOnce(new Error('connection lost'));
    expect(() => svc.publish(msg())).not.toThrow();
    await Promise.resolve();
    expect(delivered).toHaveLength(1);
  });

  it('retries creating the subscriber when RedisService is not initialised yet', () => {
    jest.useFakeTimers();
    const r = makeRedis();
    r.redis.createSubscriber
      .mockImplementationOnce(() => {
        throw new Error('Redis client is not initialised yet');
      })
      .mockImplementation(() => r.subscriber);
    const svc = new RealtimeFanoutService(r.redis as any, configOf());
    svc.onModuleInit();
    expect(r.redis.createSubscriber).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2_100);
    expect(r.redis.createSubscriber).toHaveBeenCalledTimes(2);
    expect(r.subscriber.on).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('re-subscribes every project with local subscribers when the connection becomes ready', () => {
    const { svc, subscriber } = build();
    svc.onLocalSubscriberAdded('p1');
    svc.onLocalSubscriberAdded('p2');
    subscriber.subscribe.mockClear();
    const ready = subscriber.on.mock.calls.find(([evt]) => evt === 'ready')?.[1];
    expect(ready).toBeInstanceOf(Function);
    ready();
    expect(subscriber.subscribe.mock.calls.map((c) => c[0]).sort()).toEqual(['rt:p1', 'rt:p2']);
  });
});
