import { MauTracker, mauKey, mauMonth, previousMauMonth, subjectOfToken } from './mau-tracker.service';

const flush = () => new Promise((r) => setImmediate(r));

function tokenFor(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

function makeTracker() {
  const client = {
    pfadd: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    pfcount: jest.fn().mockResolvedValue(7),
  };
  const redis = { getDurableClient: () => client } as any;
  return { tracker: new MauTracker(redis), client };
}

describe('MAU month keys', () => {
  it('uses the UTC calendar month', () => {
    expect(mauMonth(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(mauMonth(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
    expect(previousMauMonth(new Date('2026-01-15T00:00:00Z'))).toBe('2025-12');
    expect(mauKey('proj-abc', '2026-11')).toBe('usage:mau:realm:proj-abc:2026-11');
  });

  it('reads the subject of a token and nothing from garbage', () => {
    expect(subjectOfToken(tokenFor({ sub: 'u-1' }))).toBe('u-1');
    expect(subjectOfToken('not-a-jwt')).toBeNull();
    expect(subjectOfToken(undefined)).toBeNull();
    expect(subjectOfToken(tokenFor({ email: 'x' }))).toBeNull();
  });
});

describe('MauTracker', () => {
  it('adds a user to the realm and month set once per process per month', async () => {
    const { tracker, client } = makeTracker();
    const at = new Date('2026-11-23T10:00:00Z');
    tracker.record('realm-a', 'u-1', at);
    tracker.record('realm-a', 'u-1', at);
    tracker.record('realm-a', 'u-1', at);
    await flush();
    expect(client.pfadd).toHaveBeenCalledTimes(1);
    expect(client.pfadd).toHaveBeenCalledWith('usage:mau:realm:realm-a:2026-11', 'u-1');
    expect(client.expire).toHaveBeenCalledWith('usage:mau:realm:realm-a:2026-11', 40 * 24 * 60 * 60);
  });

  it('counts the same user again in a new month and in another realm', async () => {
    const { tracker, client } = makeTracker();
    tracker.record('realm-a', 'u-1', new Date('2026-11-23T10:00:00Z'));
    tracker.record('realm-a', 'u-1', new Date('2026-12-01T00:00:01Z'));
    tracker.record('realm-b', 'u-1', new Date('2026-11-23T10:00:00Z'));
    await flush();
    expect(client.pfadd).toHaveBeenCalledTimes(3);
  });

  it('ignores a missing realm or subject and never throws', async () => {
    const { tracker, client } = makeTracker();
    expect(() => tracker.record(null, 'u-1')).not.toThrow();
    expect(() => tracker.record('realm-a', null)).not.toThrow();
    tracker.recordFromAccessToken('realm-a', 'garbage');
    await flush();
    expect(client.pfadd).not.toHaveBeenCalled();
  });

  it('retries a user whose write failed on the next request', async () => {
    const { tracker, client } = makeTracker();
    client.pfadd.mockRejectedValueOnce(new Error('redis down'));
    tracker.record('realm-a', 'u-1');
    await flush();
    tracker.record('realm-a', 'u-1');
    await flush();
    expect(client.pfadd).toHaveBeenCalledTimes(2);
  });

  it('records the user behind a freshly issued token', async () => {
    const { tracker, client } = makeTracker();
    tracker.recordFromAccessToken('realm-a', tokenFor({ sub: 'u-9' }));
    await flush();
    expect(client.pfadd).toHaveBeenCalledWith(expect.stringContaining('usage:mau:realm:realm-a:'), 'u-9');
  });

  it('counts the union over an organization\'s realms, zero without realms', async () => {
    const { tracker, client } = makeTracker();
    await expect(tracker.count(['r1', 'r2', 'r1'], '2026-11')).resolves.toBe(7);
    expect(client.pfcount).toHaveBeenCalledWith('usage:mau:realm:r1:2026-11', 'usage:mau:realm:r2:2026-11');
    await expect(tracker.count([], '2026-11')).resolves.toBe(0);
  });
});
