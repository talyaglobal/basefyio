import { PlanEnforcementService, secondsUntilNextMonth } from './plan-enforcement.service';

const GB = BigInt(1024 ** 3);
const freePlan = {
  name: 'free',
  displayName: 'Free',
  priceMonthly: 0,
  features: null,
  maxApiRequests: 50_000,
  maxBandwidthBytes: GB,
  maxMau: 50_000,
  maxDbSizeBytes: GB,
};

function thisMonth() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
}

function make(opts: { modes?: unknown; plan?: any; usage?: any } = {}) {
  const prisma = {
    systemSetting: {
      findUnique: jest.fn().mockResolvedValue(opts.modes === undefined ? null : { value: opts.modes }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    subscription: { findUnique: jest.fn().mockResolvedValue({ plan: opts.plan ?? freePlan }) },
    project: { findUnique: jest.fn().mockResolvedValue({ teamId: 't1' }) },
    teamMember: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const usage = {
    getTeamUsage: jest.fn().mockResolvedValue(
      opts.usage ?? {
        apiRequestsMonth: 0,
        bandwidthMonth: BigInt(0),
        mauCount: 0,
        dbSizeBytes: BigInt(0),
        periodStart: thisMonth(),
      },
    ),
  };
  const config = { get: () => 'https://app.example.test/' };
  const service = new PlanEnforcementService(prisma as any, usage as any, config as any);
  const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  return { service, prisma, usage, warn };
}

const overApi = { apiRequestsMonth: 60_000, bandwidthMonth: BigInt(0), mauCount: 0, dbSizeBytes: BigInt(0), periodStart: thisMonth() };

describe('PlanEnforcementService modes', () => {
  it('is warn for everything when nothing is stored', async () => {
    const { service } = make();
    await expect(service.modes()).resolves.toEqual({ api_requests: 'warn', egress: 'warn', mau: 'warn', db_size: 'warn' });
  });

  it('caches the setting for a short while', async () => {
    const { service, prisma } = make({ modes: { api_requests: 'enforce' } });
    await service.modes();
    await service.modes();
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('a root change takes effect at once on this replica and is stored merged', async () => {
    const { service, prisma } = make({ modes: { mau: 'off' } });
    const next = await service.setModes({ api_requests: 'enforce' });
    expect(next).toEqual({ api_requests: 'enforce', egress: 'warn', mau: 'off', db_size: 'warn' });
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'plan_enforcement' }, update: { value: next } }),
    );
    await expect(service.modes()).resolves.toEqual(next);
  });

  it('keeps the last known modes when the read fails later', async () => {
    const { service, prisma } = make({ modes: { db_size: 'enforce' } });
    await service.modes();
    (service as any).modesCache.at = 0;
    prisma.systemSetting.findUnique.mockRejectedValueOnce(new Error('db'));
    await expect(service.modes()).resolves.toMatchObject({ db_size: 'enforce' });
  });
});

describe('PlanEnforcementService decisions', () => {
  it('admits a team below its limits even in enforce mode', async () => {
    const { service } = make({ modes: 'enforce' });
    await expect(service.checkTraffic('t1')).resolves.toBeNull();
    await expect(service.checkDbWrite('t1')).resolves.toBeNull();
    await expect(service.checkSignup('t1')).resolves.toBeNull();
  });

  it('warn mode never refuses and logs one structured would-block line per team and metric', async () => {
    const { service, warn } = make({ usage: overApi });
    await expect(service.checkTraffic('t1')).resolves.toBeNull();
    await expect(service.checkTraffic('t1')).resolves.toBeNull();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('plan_limit_would_block'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'plan_limit_would_block', teamId: 't1', metric: 'api_requests', mode: 'warn' });
  });

  it('enforce mode refuses past the grace with 429, Retry-After and an upgrade link', async () => {
    const { service } = make({ modes: { api_requests: 'enforce' }, usage: overApi });
    const r = await service.checkTraffic('t1');
    expect(r).toMatchObject({ status: 429, metric: 'api_requests', teamId: 't1' });
    expect(r!.retryAfterSeconds).toBeGreaterThan(0);
    expect(r!.body).toMatchObject({ code: 'plan_limit_exceeded', resource: 'api_requests', upgradeUrl: 'https://app.example.test/dashboard/billing' });
    expect(r!.body.message).toMatch(/50,000 API requests/);
  });

  it('switching the mode back to warn stops refusing without a deploy', async () => {
    const { service } = make({ modes: { api_requests: 'enforce' }, usage: overApi });
    expect(await service.checkTraffic('t1')).not.toBeNull();
    await service.setModes({ api_requests: 'warn' });
    expect(await service.checkTraffic('t1')).toBeNull();
  });

  it('refuses database writes with 402 and sign-ups with 402 when those are enforced', async () => {
    const { service } = make({
      modes: 'enforce',
      usage: { apiRequestsMonth: 0, bandwidthMonth: BigInt(0), mauCount: 60_000, dbSizeBytes: GB * BigInt(2), periodStart: thisMonth() },
    });
    expect(await service.checkDbWrite('t1')).toMatchObject({ status: 402, metric: 'db_size' });
    const signup = await service.checkSignup('t1');
    expect(signup).toMatchObject({ status: 402, metric: 'mau' });
    expect(signup!.body.message).toMatch(/existing users can still sign in/);
  });

  it('exempts a Legacy plan in enforce mode', async () => {
    const { service } = make({ modes: 'enforce', plan: { name: 'legacy', priceMonthly: 0, features: { grandfathered: true } }, usage: overApi });
    await expect(service.checkTraffic('t1')).resolves.toBeNull();
  });

  it('does not look anything up when every asked metric is off', async () => {
    const { service, prisma } = make({ modes: 'off', usage: overApi });
    await expect(service.checkTraffic('t1')).resolves.toBeNull();
    expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
  });

  it('fails open when the lookup fails', async () => {
    const { service, prisma } = make({ modes: 'enforce' });
    prisma.subscription.findUnique.mockRejectedValue(new Error('db down'));
    await expect(service.checkTraffic('t1')).resolves.toBeNull();
  });

  it('caches a team state between requests', async () => {
    const { service, usage } = make({ modes: 'enforce' });
    await service.checkTraffic('t1');
    await service.checkTraffic('t1');
    expect(usage.getTeamUsage).toHaveBeenCalledTimes(1);
  });

  it('caches the project to team lookup', async () => {
    const { service, prisma } = make();
    await expect(service.teamForProject('p1')).resolves.toBe('t1');
    await service.teamForProject('p1');
    expect(prisma.project.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('secondsUntilNextMonth', () => {
  it('counts to the 1st (UTC)', () => {
    expect(secondsUntilNextMonth(new Date('2026-11-30T23:59:00Z'))).toBe(60);
  });
});
