import { MAX_ATTEMPTS, RETRY_DELAYS_MS, dlqFor, retryDelayFor, retryQueueFor } from './message-bus.port';

describe('message bus port helpers', () => {
  it('backs off 10 s, 1 m, 5 m, 30 m and gives up on the fifth attempt', () => {
    expect(retryDelayFor(1)).toBe(10_000);
    expect(retryDelayFor(2)).toBe(60_000);
    expect(retryDelayFor(3)).toBe(300_000);
    expect(retryDelayFor(4)).toBe(1_800_000);
    expect(retryDelayFor(MAX_ATTEMPTS)).toBeNull();
    expect(retryDelayFor(99)).toBeNull();
    expect(RETRY_DELAYS_MS).toHaveLength(4);
  });

  it('names retry and dead-letter queues deterministically', () => {
    expect(retryQueueFor(60_000)).toBe('retry.60000');
    expect(dlqFor('jobs.webhooks')).toBe('dlq.jobs.webhooks');
  });
});
