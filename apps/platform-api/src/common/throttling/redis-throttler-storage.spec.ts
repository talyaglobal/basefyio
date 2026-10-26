import { RedisThrottlerStorage } from './redis-throttler-storage';

/**
 * The window is counted in Redis so every replica shares it, and counted in
 * memory for as long as Redis is away — never refused, never waved through.
 */
function fakeRedis(opts: { down?: boolean } = {}) {
  const store = new Map<string, { n: number; expiresAt: number }>();
  const client = {
    eval: jest.fn(async (_script: string, _nkeys: number, key: string, ttlMs: string) => {
      if (opts.down) throw new Error('ECONNREFUSED');
      const now = Date.now();
      let rec = store.get(key);
      if (!rec || rec.expiresAt <= now) {
        rec = { n: 0, expiresAt: now + Number(ttlMs) };
        store.set(key, rec);
      }
      rec.n += 1;
      return [rec.n, rec.expiresAt - now];
    }),
  };
  return { redis: { getClient: () => client } as any, client, store };
}

describe('RedisThrottlerStorage', () => {
  it('counts hits in Redis under a key that names the throttler and the client', async () => {
    const { redis, client, store } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);

    const first = await storage.increment('1.2.3.4', 60_000, 300, 0, 'default');
    const second = await storage.increment('1.2.3.4', 60_000, 300, 0, 'default');

    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'throttle:default:1.2.3.4', '60000');
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.timeToExpire).toBeGreaterThan(0);
    expect(second.isBlocked).toBe(false);
    expect(store.size).toBe(1);
  });

  it('keeps separate windows for separate clients', async () => {
    const { redis } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);

    await storage.increment('a', 60_000, 300, 0, 'default');
    const b = await storage.increment('b', 60_000, 300, 0, 'default');

    expect(b.totalHits).toBe(1);
  });

  it('counts in memory while Redis is unreachable, and still reports the window', async () => {
    const { redis } = fakeRedis({ down: true });
    const storage = new RedisThrottlerStorage(redis);

    const first = await storage.increment('1.2.3.4', 60_000, 300, 0, 'default');
    const second = await storage.increment('1.2.3.4', 60_000, 300, 0, 'default');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.timeToExpire).toBeGreaterThan(0);
  });

  it('starts a fresh in-memory window once the old one has expired', async () => {
    const { redis } = fakeRedis({ down: true });
    const storage = new RedisThrottlerStorage(redis);

    await storage.increment('1.2.3.4', 1, 300, 0, 'default');
    await new Promise((r) => setTimeout(r, 5));
    const again = await storage.increment('1.2.3.4', 1, 300, 0, 'default');

    expect(again.totalHits).toBe(1);
  });
});
