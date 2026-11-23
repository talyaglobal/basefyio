import { HttpException } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import { PlanGateInterceptor, projectIdOf } from './plan-gate.interceptor';
import { isTrafficExempt, UsageTrackingMiddleware } from '../../common/middleware/usage-tracking.middleware';
import { sqlGrowsDatabase } from '../sql/sql-growth';

const refusal402 = (metric: string) => ({
  status: 402,
  metric,
  teamId: 't1',
  body: { statusCode: 402, code: 'plan_limit_exceeded', resource: metric, message: 'over' },
});

function ctx(req: any, kind?: string) {
  return {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
    kind,
  } as any;
}

function interceptor(kind: string | undefined, enforcement: any) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(kind) } as any;
  return new PlanGateInterceptor(reflector, enforcement);
}

const next = { handle: jest.fn(() => of('handled')) };

function enforcementWith(over: { db?: boolean; mau?: boolean; member?: boolean } = {}) {
  return {
    teamForProject: jest.fn().mockResolvedValue('t1'),
    checkDbWrite: jest.fn().mockResolvedValue(over.db ? refusal402('db_size') : null),
    checkSignup: jest.fn().mockResolvedValue(over.mau ? refusal402('mau') : null),
    isTeamMember: jest.fn().mockResolvedValue(over.member ?? true),
  };
}

describe('PlanGateInterceptor', () => {
  beforeEach(() => next.handle.mockClear());

  it('leaves an unmarked route alone without any lookup', async () => {
    const e = enforcementWith({ db: true });
    const out = await interceptor(undefined, e).intercept(ctx({ apiKeyPayload: { projectId: 'p1' } }), next);
    await expect(lastValueFrom(out)).resolves.toBe('handled');
    expect(e.teamForProject).not.toHaveBeenCalled();
  });

  it('refuses a data API write with 402 when the database is past the limit (enforce)', async () => {
    const e = enforcementWith({ db: true });
    await expect(
      interceptor('db_write', e).intercept(ctx({ apiKeyPayload: { projectId: 'p1' } }), next),
    ).rejects.toMatchObject({ status: 402 });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('lets the write through when the service admits it (below the limit, or warn mode)', async () => {
    const e = enforcementWith();
    const out = await interceptor('db_write', e).intercept(ctx({ apiKeyPayload: { projectId: 'p1' } }), next);
    await expect(lastValueFrom(out)).resolves.toBe('handled');
  });

  it('runs SELECT, DELETE and TRUNCATE through SQL execute past the limit, refuses INSERT', async () => {
    const e = enforcementWith({ db: true, member: true });
    const i = interceptor('sql', e);
    for (const query of ['SELECT * FROM t', 'DELETE FROM t WHERE id < 10', 'TRUNCATE t; VACUUM FULL t']) {
      const out = await i.intercept(ctx({ user: { sub: 'u1' }, body: { projectId: 'p1', query } }), next);
      await expect(lastValueFrom(out)).resolves.toBe('handled');
    }
    expect(e.checkDbWrite).not.toHaveBeenCalled();
    await expect(
      i.intercept(ctx({ user: { sub: 'u1' }, body: { projectId: 'p1', query: 'INSERT INTO t VALUES (1)' } }), next),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('a dashboard caller who is not a member of the organization gets the route\'s own answer', async () => {
    const e = enforcementWith({ db: true, member: false });
    const out = await interceptor('db_write', e).intercept(
      ctx({ user: { sub: 'stranger' }, params: { projectId: 'p1' } }),
      next,
    );
    await expect(lastValueFrom(out)).resolves.toBe('handled');
  });

  it('refuses a new sign-up past the MAU limit and never asks about database size for it', async () => {
    const e = enforcementWith({ mau: true, db: true });
    await expect(
      interceptor('signup', e).intercept(ctx({ apiKeyPayload: { projectId: 'p1' } }), next),
    ).rejects.toMatchObject({ status: 402 });
    expect(e.checkDbWrite).not.toHaveBeenCalled();
  });

  it('admits when the lookup throws', async () => {
    const e = enforcementWith();
    e.teamForProject.mockRejectedValue(new Error('db'));
    const out = await interceptor('db_write', e).intercept(ctx({ apiKeyPayload: { projectId: 'p1' } }), next);
    await expect(lastValueFrom(out)).resolves.toBe('handled');
  });

  it('finds the project from the key, the route or the body', () => {
    expect(projectIdOf({ apiKeyPayload: { projectId: 'a' }, params: { projectId: 'b' } })).toBe('a');
    expect(projectIdOf({ params: { projectId: 'b' } })).toBe('b');
    expect(projectIdOf({ body: { projectId: 'c' } })).toBe('c');
    expect(projectIdOf({})).toBeNull();
  });
});

describe('sqlGrowsDatabase', () => {
  it.each([
    ['SELECT 1', false],
    ['select * from users where id = 1; select count(*) from t', false],
    ['WITH a AS (SELECT 1) SELECT * FROM a', false],
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT count(*) FROM d', false],
    ['DELETE FROM logs WHERE created_at < now()', false],
    ['TRUNCATE big_table', false],
    ['DROP TABLE old', false],
    ['VACUUM FULL big_table', false],
    ['EXPLAIN SELECT * FROM t', false],
    ['BEGIN; DELETE FROM t; COMMIT;', false],
    ['-- INSERT INTO t\nSELECT 1', false],
    ["SELECT 'insert into t values (1)'", false],
    ['', false],
    ['INSERT INTO t VALUES (1)', true],
    ['UPDATE t SET a = 1', true],
    ['CREATE TABLE x (id int)', true],
    ['ALTER TABLE x ADD COLUMN y text', true],
    ['SELECT * INTO new_t FROM t', true],
    ['WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i', true],
    ['EXPLAIN ANALYZE INSERT INTO t VALUES (1)', true],
    ['SELECT 1; INSERT INTO t VALUES (2)', true],
    ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a', true],
  ])('%s → %s', (query, grows) => {
    expect(sqlGrowsDatabase(query)).toBe(grows);
  });
});

describe('UsageTrackingMiddleware and plan limits', () => {
  function mw(refusal: any) {
    const prisma = { project: { findUnique: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1' }) } } as any;
    const usage = { trackApiRequest: jest.fn().mockResolvedValue(undefined), trackBandwidth: jest.fn().mockResolvedValue(undefined) } as any;
    const enforcement = { checkTraffic: jest.fn().mockResolvedValue(refusal) } as any;
    const m = new UsageTrackingMiddleware(prisma, usage, enforcement);
    clearInterval((m as any).evictionTimer);
    return { m, usage, enforcement };
  }
  const res = () => {
    const r: any = { headers: {} as Record<string, string>, statusCode: 200, body: '' };
    r.setHeader = (k: string, v: string) => (r.headers[k] = v);
    r.end = jest.fn((b?: string) => (r.body = b ?? ''));
    r.write = jest.fn();
    return r;
  };
  const req = (url: string) => ({ originalUrl: url, url, headers: { 'x-project-id': 'p1' } }) as any;
  const over = {
    status: 429,
    metric: 'api_requests',
    teamId: 't1',
    retryAfterSeconds: 3600,
    body: { statusCode: 429, code: 'plan_limit_exceeded', message: 'over' },
  };

  it('answers 429 with Retry-After past the limit in enforce mode and does not count the refused request', async () => {
    const { m, usage } = mw(over);
    const r = res();
    const next = jest.fn();
    await m.use(req('/api/rest/v1/todos'), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(429);
    expect(r.headers['Retry-After']).toBe('3600');
    expect(JSON.parse(r.body)).toMatchObject({ code: 'plan_limit_exceeded' });
    expect(usage.trackApiRequest).not.toHaveBeenCalled();
  });

  it('never refuses health, billing, platform sign-in or project auth (sign-in and refresh)', async () => {
    for (const path of [
      '/api/health',
      '/api/health/ready',
      '/api/billing/subscription',
      '/api/billing/webhook',
      '/api/auth/refresh',
      '/api/auth/v1/token',
      '/auth/v1/token',
      '/api/rest/v1/auth/refresh',
      '/api/rest/v1/auth/signin',
    ]) {
      const { m, enforcement } = mw(over);
      const next = jest.fn();
      await m.use(req(path), res(), next);
      expect(next).toHaveBeenCalled();
      expect(enforcement.checkTraffic).not.toHaveBeenCalled();
    }
    expect(isTrafficExempt('/api/rest/v1/todos')).toBe(false);
    expect(isTrafficExempt('/api/storage/v1/object/b/x')).toBe(false);
  });

  it('a team below its limits is untouched: the request passes and is counted', async () => {
    const { m, usage } = mw(null);
    const next = jest.fn();
    await m.use(req('/api/rest/v1/todos'), res(), next);
    expect(next).toHaveBeenCalled();
    expect(usage.trackApiRequest).toHaveBeenCalledWith('t1', 'p1');
  });

  it('a dashboard request (no API key, no project header) is never checked', async () => {
    const { m, enforcement } = mw(over);
    const next = jest.fn();
    await m.use({ originalUrl: '/api/projects', url: '/api/projects', headers: { authorization: 'Bearer x' } } as any, res(), next);
    expect(next).toHaveBeenCalled();
    expect(enforcement.checkTraffic).not.toHaveBeenCalled();
  });

  it('passes when the check itself fails', async () => {
    const { m, enforcement } = mw(null);
    enforcement.checkTraffic.mockRejectedValue(new Error('boom'));
    const next = jest.fn();
    await m.use(req('/api/rest/v1/todos'), res(), next);
    expect(next).toHaveBeenCalled();
  });
});
