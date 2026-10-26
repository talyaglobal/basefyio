/**
 * A token bucket in Redis, atomic through Lua: one bucket per project (or per
 * user for dashboard traffic), refilled at `rate` tokens per second up to
 * `burst`. The script returns whether a token was taken, how many remain, and
 * how long until the next token, so the response can carry RateLimit-* headers.
 *
 * Keys hold two numbers (tokens, last-refill ms) and expire on their own once
 * the bucket would be full again, so idle projects cost nothing.
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = burst
  ts = now
end
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(burst, tokens + elapsed * rate)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HSET', key, 't', tokens, 'ts', now)
local ttl = math.ceil(((burst - tokens) / rate) + 1)
if ttl < 1 then ttl = 1 end
redis.call('EXPIRE', key, ttl)
local retry = 0
if allowed == 0 then
  retry = math.ceil(((cost - tokens) / rate) * 1000)
end
return {allowed, math.floor(tokens), retry}
`;

export interface BucketLimits {
  /** Tokens per second. */
  rate: number;
  /** Bucket size. */
  burst: number;
}

export interface BucketResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until a token is available; 0 when allowed. */
  retryAfterMs: number;
  limit: BucketLimits;
}

/** Pure in-memory reference implementation, used by the spec and as the fallback when Redis is unreachable. */
export class MemoryTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; ts: number }>();

  take(key: string, limits: BucketLimits, now = Date.now(), cost = 1): BucketResult {
    const b = this.buckets.get(key) ?? { tokens: limits.burst, ts: now };
    const elapsed = Math.max(0, now - b.ts) / 1000;
    let tokens = Math.min(limits.burst, b.tokens + elapsed * limits.rate);
    let allowed = false;
    if (tokens >= cost) {
      tokens -= cost;
      allowed = true;
    }
    this.buckets.set(key, { tokens, ts: now });
    return {
      allowed,
      remaining: Math.floor(tokens),
      retryAfterMs: allowed ? 0 : Math.ceil(((cost - tokens) / limits.rate) * 1000),
      limit: limits,
    };
  }
}

export function parseBucketReply(reply: unknown, limits: BucketLimits): BucketResult {
  const arr = Array.isArray(reply) ? reply : [];
  return {
    allowed: Number(arr[0]) === 1,
    remaining: Number(arr[1] ?? 0),
    retryAfterMs: Number(arr[2] ?? 0),
    limit: limits,
  };
}
