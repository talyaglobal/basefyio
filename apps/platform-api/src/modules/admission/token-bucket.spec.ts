import { MemoryTokenBucket, parseBucketReply } from './token-bucket';

describe('token bucket (reference implementation)', () => {
  it('allows a burst, then refills at the rate', () => {
    const b = new MemoryTokenBucket();
    const limits = { rate: 10, burst: 3 };
    const t0 = 1_000_000;
    expect(b.take('p1', limits, t0).allowed).toBe(true);
    expect(b.take('p1', limits, t0).allowed).toBe(true);
    expect(b.take('p1', limits, t0).allowed).toBe(true);
    const denied = b.take('p1', limits, t0);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBe(100); // one token at 10/s
    // 250 ms later: 2.5 tokens refilled
    const later = b.take('p1', limits, t0 + 250);
    expect(later.allowed).toBe(true);
    expect(later.remaining).toBe(1);
  });

  it('never exceeds the burst and keys are independent', () => {
    const b = new MemoryTokenBucket();
    const limits = { rate: 1, burst: 2 };
    expect(b.take('a', limits, 0).remaining).toBe(1);
    expect(b.take('b', limits, 0).remaining).toBe(1);
    // an hour later the bucket is full again, not larger
    expect(b.take('a', limits, 3_600_000).remaining).toBe(1);
  });

  it('parses the Lua reply shape', () => {
    expect(parseBucketReply([1, 7, 0], { rate: 5, burst: 10 })).toEqual({ allowed: true, remaining: 7, retryAfterMs: 0, limit: { rate: 5, burst: 10 } });
    expect(parseBucketReply(['0', '0', '200'], { rate: 5, burst: 10 }).allowed).toBe(false);
    expect(parseBucketReply(null, { rate: 5, burst: 10 }).allowed).toBe(false);
  });
});
