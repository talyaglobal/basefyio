import { RealtimePresenceService } from './realtime-presence.service';
import type { FanoutMessage, PresenceEvent } from './realtime-data.types';

/**
 * Who is on a channel.
 *
 * A member joins on its first connection and leaves on its last; everybody on
 * the channel hears both, the joiner alone receives the current list. The
 * same bookkeeping runs in Redis (several instances) or in memory (one).
 */
type Published = Omit<FanoutMessage, 'v' | 'origin'>;

function fanoutMock(enabled: boolean) {
  const published: Published[] = [];
  const local: Published[] = [];
  return {
    published,
    local,
    fanout: {
      isEnabled: () => enabled,
      publish: (m: Published) => void published.push(m),
      publishLocal: (m: Published) => void local.push(m),
    } as any,
  };
}

const configOf = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as any;

const ev = (m: Published) => m.event as PresenceEvent;

describe('RealtimePresenceService — in-memory (single instance)', () => {
  function build(env?: Record<string, string>) {
    const f = fanoutMock(false);
    const redis = { isReady: () => false, getClient: () => ({}) } as any;
    const svc = new RealtimePresenceService(redis, f.fanout, configOf(env));
    return { svc, ...f };
  }
  const sub = (id: string, key: string, meta?: Record<string, unknown>) => ({
    id,
    projectId: 'p1',
    channels: ['broadcast:room'],
    presenceKey: key,
    presenceMeta: meta,
  });

  it('announces a new member and sends the joiner alone the current list', async () => {
    const { svc, published, local } = build();
    await svc.join(sub('s1', 'alice', { color: 'red' }));
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 'presence', projectId: 'p1', channel: 'broadcast:room' });
    expect(ev(published[0])).toMatchObject({ type: 'join', key: 'alice', meta: { color: 'red' } });
    expect(local).toHaveLength(1);
    expect(local[0].only).toBe('s1');
    expect(ev(local[0]).type).toBe('sync');
    expect(ev(local[0]).members?.map((m) => m.key)).toEqual(['alice']);
  });

  it('a second connection of the same member is no second join, and leaving one of two is no leave', async () => {
    const { svc, published } = build();
    await svc.join(sub('s1', 'alice'));
    await svc.join(sub('s2', 'alice'));
    expect(published.filter((m) => ev(m).type === 'join')).toHaveLength(1);
    await svc.leave('s1');
    expect(published.filter((m) => ev(m).type === 'leave')).toHaveLength(0);
    await svc.leave('s2');
    expect(published.filter((m) => ev(m).type === 'leave')).toHaveLength(1);
    expect(ev(published[published.length - 1])).toMatchObject({ type: 'leave', key: 'alice' });
  });

  it('the sync lists everyone already there', async () => {
    const { svc, local } = build();
    await svc.join(sub('s1', 'alice'));
    await svc.join(sub('s2', 'bob'));
    const bobSync = local.find((m) => m.only === 's2');
    expect(ev(bobSync!).members?.map((m) => m.key).sort()).toEqual(['alice', 'bob']);
  });

  it('ignores the wildcard channel', async () => {
    const { svc, published, local } = build();
    await svc.join({ ...sub('s1', 'alice'), channels: ['*'] });
    expect(published).toHaveLength(0);
    expect(local).toHaveLength(0);
    expect(svc.isTracked('s1')).toBe(false);
  });

  it('a heartbeat refreshes the member\'s last-seen time', async () => {
    const { svc } = build();
    const t0 = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    await svc.join(sub('s1', 'alice'));
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 5_000);
    await svc.heartbeat('s1');
    const { list } = await svc.members('p1', 'broadcast:room', t0 + 5_000);
    expect(list[0]).toMatchObject({ key: 'alice', lastSeen: t0 + 5_000 });
    jest.restoreAllMocks();
  });

  it('the sweeper announces a member whose heartbeats stopped', async () => {
    const { svc, published } = build({ REALTIME_PRESENCE_TTL_SEC: '10' });
    const t0 = 2_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    await svc.join(sub('s1', 'alice'));
    await svc.sweep(t0 + 11_000);
    expect(published.filter((m) => ev(m).type === 'leave').map((m) => ev(m).key)).toEqual(['alice']);
    const { list } = await svc.members('p1', 'broadcast:room', t0 + 11_000);
    expect(list).toHaveLength(0);
    jest.restoreAllMocks();
  });

  it('leave for an untracked subscription is a no-op', async () => {
    const { svc, published } = build();
    await svc.leave('nobody');
    expect(published).toHaveLength(0);
  });
});

describe('RealtimePresenceService — Redis (several instances)', () => {
  function build() {
    const f = fanoutMock(true);
    const client = {
      zremrangebyscore: jest.fn().mockResolvedValue(0),
      zrange: jest.fn().mockResolvedValue([]),
      zrangebyscore: jest.fn().mockResolvedValue([]),
      hgetall: jest.fn().mockResolvedValue({}),
      zadd: jest.fn().mockResolvedValue(1),
      hset: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      zrem: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const redis = { isReady: () => true, getClient: () => client } as any;
    const svc = new RealtimePresenceService(redis, f.fanout, configOf({ REALTIME_PRESENCE_TTL_SEC: '90' }));
    return { svc, client, ...f };
  }
  const sub = { id: 's1', projectId: 'p1', channels: ['broadcast:room'], presenceKey: 'alice', presenceMeta: { a: 1 } };

  it('records the member in the channel set with a TTL and its metadata in the hash', async () => {
    const { svc, client, published } = build();
    const now = 3_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await svc.join(sub);
    expect(client.zadd).toHaveBeenCalledWith('rt:presence:p1:broadcast:room', now, `alice\u0001s1`);
    expect(client.hset).toHaveBeenCalledWith('rt:presence-meta:p1:broadcast:room', 'alice', JSON.stringify({ a: 1 }));
    expect(client.expire).toHaveBeenCalledWith('rt:presence:p1:broadcast:room', 90);
    expect(client.expire).toHaveBeenCalledWith('rt:presence-meta:p1:broadcast:room', 90);
    expect(published.map((m) => ev(m).type)).toEqual(['join']);
    jest.restoreAllMocks();
  });

  it('does not announce a join when another connection of the same member is already listed', async () => {
    const { svc, client, published } = build();
    client.zrange.mockResolvedValueOnce([`alice\u0001other`, '2999000']);
    await svc.join(sub);
    expect(published).toHaveLength(0);
  });

  it('removes the member row, and announces the leave only when no row of that member remains', async () => {
    const { svc, client, published } = build();
    await svc.join(sub);
    published.length = 0;
    client.zrange.mockResolvedValueOnce([`alice\u0001other`, '2999000']);
    await svc.leave('s1');
    expect(client.zrem).toHaveBeenCalledWith('rt:presence:p1:broadcast:room', `alice\u0001s1`);
    expect(published).toHaveLength(0);

    await svc.join(sub);
    published.length = 0;
    client.zrange.mockResolvedValueOnce([]);
    await svc.leave('s1');
    expect(client.hdel).toHaveBeenCalledWith('rt:presence-meta:p1:broadcast:room', 'alice');
    expect(published.map((m) => ev(m).type)).toEqual(['leave']);
  });

  it('the sweeper claims a departure with SET NX so only one instance announces it', async () => {
    const { svc, client, published } = build();
    await svc.join(sub);
    published.length = 0;
    client.zrangebyscore.mockResolvedValueOnce([`bob\u0001s9`]);
    client.zrange.mockResolvedValueOnce([`alice\u0001s1`, '3000000']);
    await svc.sweep();
    expect(client.set).toHaveBeenCalledWith('rt:presence-left:p1:broadcast:room:bob', '1', 'EX', 60, 'NX');
    expect(published.map((m) => ev(m).key)).toEqual(['bob']);

    published.length = 0;
    client.zrangebyscore.mockResolvedValueOnce([`carol\u0001s7`]);
    client.zrange.mockResolvedValueOnce([`alice\u0001s1`, '3000000']);
    client.set.mockResolvedValueOnce(null);
    await svc.sweep();
    expect(published).toHaveLength(0);
  });

  it('members() purges stale rows and merges metadata', async () => {
    const { svc, client } = build();
    client.zrange.mockResolvedValueOnce([`alice\u0001s1`, '100', `alice\u0001s2`, '200', `bob\u0001s3`, '150']);
    client.hgetall.mockResolvedValueOnce({ alice: JSON.stringify({ a: 1 }), bob: 'not json' });
    const { list, truncated } = await svc.members('p1', 'broadcast:room', 10_000);
    expect(client.zremrangebyscore).toHaveBeenCalledWith('rt:presence:p1:broadcast:room', '-inf', `(${10_000 - 90_000}`);
    expect(list).toEqual([
      { key: 'alice', meta: { a: 1 }, lastSeen: 200 },
      { key: 'bob', meta: undefined, lastSeen: 150 },
    ]);
    expect(truncated).toBe(false);
  });
});
