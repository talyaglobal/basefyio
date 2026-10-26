import { HttpException } from '@nestjs/common';
import { RateLimitGuard, RATE_LIMIT_KEY } from './rate-limit.guard';

/**
 * The per-route limiter must key on the client Express resolved behind the
 * trusted proxies, never on a header the client wrote, and must count and
 * start the window in one step.
 */
function build(limit: { maxRequests: number; windowSeconds: number } | undefined) {
  const counts = new Map<string, number>();
  const expired: string[] = [];
  const client = {
    eval: jest.fn(async (_script: string, _n: number, key: string, window: string) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n === 1) expired.push(`${key}:${window}`);
      return n;
    }),
  };
  const redis = { getClient: () => client } as any;
  const reflector = { get: (meta: string) => (meta === RATE_LIMIT_KEY ? limit : undefined) } as any;
  const guard = new RateLimitGuard(reflector, redis);
  const ctx = (req: Record<string, unknown>) =>
    ({ getHandler: () => undefined, switchToHttp: () => ({ getRequest: () => req }) }) as any;
  return { guard, ctx, client, counts, expired };
}

describe('RateLimitGuard', () => {
  it('lets a route without a limit through untouched', async () => {
    const { guard, ctx, client } = build(undefined);
    await expect(guard.canActivate(ctx({ ip: '1.2.3.4' }))).resolves.toBe(true);
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('keys on req.ip and ignores a client-supplied X-Forwarded-For', async () => {
    const { guard, ctx, counts } = build({ maxRequests: 10, windowSeconds: 60 });
    await guard.canActivate(
      ctx({ ip: '1.2.3.4', headers: { 'x-forwarded-for': '9.9.9.9' }, route: { path: '/auth/login' } }),
    );
    expect([...counts.keys()]).toEqual(['rl:/auth/login:1.2.3.4']);
  });

  it('starts the window with the first hit, in the same call', async () => {
    const { guard, ctx, expired } = build({ maxRequests: 10, windowSeconds: 60 });
    await guard.canActivate(ctx({ ip: '1.2.3.4', headers: {}, route: { path: '/auth/login' } }));
    await guard.canActivate(ctx({ ip: '1.2.3.4', headers: {}, route: { path: '/auth/login' } }));
    expect(expired).toEqual(['rl:/auth/login:1.2.3.4:60']);
  });

  it('refuses the request after the limit, with 429', async () => {
    const { guard, ctx } = build({ maxRequests: 2, windowSeconds: 60 });
    const req = () => ctx({ ip: '1.2.3.4', headers: {}, route: { path: '/auth/login' } });
    await expect(guard.canActivate(req())).resolves.toBe(true);
    await expect(guard.canActivate(req())).resolves.toBe(true);
    await expect(guard.canActivate(req())).rejects.toBeInstanceOf(HttpException);
  });
});
