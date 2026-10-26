import { AdmissionService } from './admission.service';
import { drainState } from '../../common/utils/drain-state';

function makeService(opts: { evalReply?: unknown; evalFails?: boolean; plan?: { name: string; features?: unknown } | null } = {}) {
  const prisma = {
    project: { findUnique: jest.fn().mockResolvedValue({ teamId: 't1' }) },
    subscription: { findUnique: jest.fn().mockResolvedValue(opts.plan === undefined ? { plan: { name: 'pro', features: null } } : opts.plan ? { plan: opts.plan } : null) },
  };
  const evalFn = opts.evalFails ? jest.fn().mockRejectedValue(new Error('redis down')) : jest.fn().mockResolvedValue(opts.evalReply ?? [1, 399, 0]);
  const redis = { getClient: () => ({ eval: evalFn }) };
  const metrics = { increment: jest.fn(), setGauge: jest.fn() };
  const service = new AdmissionService(prisma as any, redis as any, metrics as any);
  return { service, prisma, evalFn, metrics };
}

const customer = { path: '/api/rest/v1/items', method: 'GET', projectId: 'p1', userId: null };
const dashboard = { path: '/api/projects', method: 'GET', projectId: null, userId: 'u1' };
const anonymous = { path: '/api/billing/plans', method: 'GET', projectId: null, userId: null };

describe('AdmissionService', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('ADMISSION_')) delete process.env[k];
    Object.assign(process.env, saved);
    drainState.reset();
  });

  it('classifies lanes: API key → customer, JWT → dashboard, neither → anonymous', () => {
    const { service } = makeService();
    expect(service.laneFor(customer)).toBe('customer');
    expect(service.laneFor(dashboard)).toBe('dashboard');
    expect(service.laneFor(anonymous)).toBe('anonymous');
    expect(service.laneFor({ ...customer, userId: 'u1' })).toBe('customer');
  });

  it('log mode admits everything, counts a would-be rate limit, and sizes the bucket from the plan', async () => {
    process.env.ADMISSION_MODE = 'log';
    const { service, evalFn, metrics } = makeService({ evalReply: [0, 0, 250] });
    const out = await service.admit(customer);
    expect(out.decision).toBe('admit');
    expect(out.enforced).toBe(false);
    expect(out.bucket?.allowed).toBe(false);
    // pro plan: 200 rps, burst 400
    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, 'adm:p:p1', 200, 400, expect.any(Number), 1);
    expect(metrics.increment).toHaveBeenCalledWith('admission_would_rate_limited_customer');
    expect(metrics.increment).toHaveBeenCalledWith('admission_would_admit_customer');
    out.release();
  });

  it('enforce mode rejects a request without a token with the retry hint', async () => {
    process.env.ADMISSION_MODE = 'enforce';
    const { service, metrics } = makeService({ evalReply: [0, 0, 250] });
    service.reconfigure();
    const out = await service.admit(customer);
    expect(out.decision).toBe('rate_limited');
    expect(out.bucket?.retryAfterMs).toBe(250);
    expect(metrics.increment).toHaveBeenCalledWith('admission_rate_limited_customer');
  });

  it('falls back to the in-memory bucket when Redis fails, and keeps admitting', async () => {
    process.env.ADMISSION_MODE = 'enforce';
    const { service } = makeService({ evalFails: true });
    service.reconfigure();
    const out = await service.admit(customer);
    expect(out.decision).toBe('admit');
    expect(out.bucket?.allowed).toBe(true);
    out.release();
  });

  it('dashboard sessions get their own bucket and anonymous traffic none', async () => {
    const { service, evalFn } = makeService();
    const d = await service.admit(dashboard);
    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, 'adm:u:u1', 100, 300, expect.any(Number), 1);
    d.release();
    const a = await service.admit(anonymous);
    expect(a.bucket).toBeNull();
    a.release();
  });

  it('a draining process is counted, and refused only under enforce', async () => {
    process.env.ADMISSION_MODE = 'log';
    const { service, metrics } = makeService();
    service.reconfigure();
    drainState.start();
    const logged = await service.admit(anonymous);
    expect(logged.decision).toBe('admit');
    expect(metrics.increment).toHaveBeenCalledWith('admission_would_draining_anonymous');
    logged.release();

    process.env.ADMISSION_MODE = 'enforce';
    service.reconfigure();
    const refused = await service.admit(anonymous);
    expect(refused.decision).toBe('draining');
  });

  it('caches the plan lookup for a minute', async () => {
    const { service, prisma } = makeService();
    await service.limitsForProject('p1');
    await service.limitsForProject('p1');
    expect(prisma.project.findUnique).toHaveBeenCalledTimes(1);
  });
});
