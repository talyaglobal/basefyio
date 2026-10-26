import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
// The record type is not re-exported from the package root.
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from '../../modules/redis/redis.service';

/**
 * One hit, one script: count it, start the window on the first hit, and
 * read how long the window has left. Returns `{ hits, ttlMs }`.
 */
const COUNT_HIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then ttl = tonumber(ARGV[1]) end
return {n, ttl}
`;

interface MemoryRecord {
  hits: number;
  expiresAt: number;
}

/**
 * Rate-limit counters shared by every replica.
 *
 * The default storage counts in each process's memory, so two replicas allow
 * twice the limit and a restart forgets everything. Redis makes the window
 * one window for the platform. When Redis cannot be reached the counter
 * falls back to this process's memory for the duration, so a Redis outage
 * degrades to the old behaviour instead of refusing or waving through every
 * request.
 *
 * Blocking (a penalty window after the limit is hit) is not used by this
 * platform's throttlers, so a record never reports `isBlocked`; the guard
 * refuses on `totalHits > limit` exactly as before.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly memory = new Map<string, MemoryRecord>();
  private fallbackLogged = false;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `throttle:${throttlerName}:${key}`;
    try {
      const [hits, ttlMs] = (await this.redis
        .getClient()
        .eval(COUNT_HIT, 1, redisKey, String(ttl))) as [number, number];
      this.fallbackLogged = false;
      return this.record(Number(hits), Number(ttlMs), limit);
    } catch (err: any) {
      if (!this.fallbackLogged) {
        this.fallbackLogged = true;
        this.logger.warn(`Rate limits counted in memory while Redis is unreachable: ${err?.message ?? err}`);
      }
      return this.incrementInMemory(redisKey, ttl, limit);
    }
  }

  private incrementInMemory(key: string, ttl: number, limit: number): ThrottlerStorageRecord {
    const now = Date.now();
    let rec = this.memory.get(key);
    if (!rec || rec.expiresAt <= now) {
      rec = { hits: 0, expiresAt: now + ttl };
      this.memory.set(key, rec);
      this.sweepMemory(now);
    }
    rec.hits += 1;
    return this.record(rec.hits, rec.expiresAt - now, limit);
  }

  /** Keep the fallback map from growing without bound during a long outage. */
  private sweepMemory(now: number): void {
    if (this.memory.size < 10_000) return;
    for (const [k, v] of this.memory) {
      if (v.expiresAt <= now) this.memory.delete(k);
    }
  }

  private record(hits: number, ttlMs: number, _limit: number): ThrottlerStorageRecord {
    return {
      totalHits: hits,
      timeToExpire: Math.max(1, Math.ceil(ttlMs / 1000)),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
