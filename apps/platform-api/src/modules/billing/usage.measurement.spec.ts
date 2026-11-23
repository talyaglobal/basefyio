import { UsageService, monthStartUtc } from './usage.service';
import { normalizeApiPath, UsageTrackingMiddleware } from '../../common/middleware/usage-tracking.middleware';

function makeUsage(overrides: { prisma?: any; counters?: any; mau?: any } = {}) {
  const counters = {
    get: jest.fn().mockResolvedValue(null),
    getdel: jest.fn().mockResolvedValue(null),
    incr: jest.fn(),
    incrby: jest.fn().mockResolvedValue(1),
    expire: jest.fn(),
    mget: jest.fn().mockResolvedValue([]),
    ...overrides.counters,
  };
  const prisma = {
    project: { findMany: jest.fn().mockResolvedValue([]) },
    team: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    teamUsage: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    projectUsage: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn(),
    },
    usageRecord: { create: jest.fn(), createMany: jest.fn() },
    ...overrides.prisma,
  };
  const redis = { durable: () => counters } as any;
  const service = new UsageService(prisma as any, redis, { get: () => undefined } as any, overrides.mau);
  return { service, prisma, counters };
}

describe('monthStartUtc', () => {
  it('is the first instant of the UTC month', () => {
    expect(monthStartUtc(new Date('2026-11-23T09:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(monthStartUtc(new Date('2026-12-01T00:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('UsageService.measureMau', () => {
  it('writes each organization the distinct users of all its realms', async () => {
    const mau = { count: jest.fn().mockImplementation(async (realms: string[]) => realms.length * 10) };
    const { service, prisma } = makeUsage({ mau });
    prisma.project.findMany.mockResolvedValue([
      { teamId: 't1', keycloakRealm: 'r1' },
      { teamId: 't1', keycloakRealm: 'r2' },
      { teamId: 't2', keycloakRealm: 'r3' },
      { teamId: 't3', keycloakRealm: '' },
    ]);
    await service.measureMau('2026-11');
    expect(mau.count).toHaveBeenCalledWith(['r1', 'r2'], '2026-11');
    expect(prisma.teamUsage.updateMany).toHaveBeenCalledWith({ where: { teamId: 't1' }, data: { mauCount: 20 } });
    expect(prisma.teamUsage.updateMany).toHaveBeenCalledWith({ where: { teamId: 't2' }, data: { mauCount: 10 } });
    expect(prisma.teamUsage.updateMany).toHaveBeenCalledTimes(2);
  });

  it('is a no-op without a tracker and survives a failing team', async () => {
    const { service } = makeUsage();
    await expect(service.measureMau()).resolves.toBe(0);
    const mau = { count: jest.fn().mockRejectedValueOnce(new Error('redis')).mockResolvedValue(3) };
    const second = makeUsage({ mau });
    second.prisma.project.findMany.mockResolvedValue([
      { teamId: 't1', keycloakRealm: 'r1' },
      { teamId: 't2', keycloakRealm: 'r2' },
    ]);
    await expect(second.service.measureMau('2026-11')).resolves.toBe(1);
  });
});

describe('UsageService monthly reset', () => {
  const now = new Date('2026-12-01T00:00:05Z');
  const monthStart = new Date('2026-12-01T00:00:00Z');

  it('closes only rows of an earlier month, each guarded on that condition', async () => {
    const { service, prisma, counters } = makeUsage();
    prisma.teamUsage.findMany.mockResolvedValue([
      {
        teamId: 't1',
        apiRequestsMonth: 10,
        bandwidthMonth: BigInt(5),
        storageBytes: BigInt(0),
        dbSizeBytes: BigInt(0),
        mauCount: 3,
      },
    ]);
    counters.getdel.mockResolvedValueOnce('2').mockResolvedValueOnce('1');
    await service.resetMonthlyCounters(now);
    expect(prisma.teamUsage.findMany).toHaveBeenCalledWith({ where: { periodStart: { lt: monthStart } } });
    expect(prisma.usageRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ teamId: 't1', metric: 'api_requests', value: BigInt(12) }) }),
    );
    expect(prisma.teamUsage.updateMany).toHaveBeenCalledWith({
      where: { teamId: 't1', periodStart: { lt: monthStart } },
      data: expect.objectContaining({ apiRequestsMonth: 0, mauCount: 0, periodStart: monthStart }),
    });
    expect(prisma.projectUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { periodStart: { lt: monthStart } } }),
    );
  });

  it('catches up a missed reset, and does nothing when every row is current', async () => {
    const { service, prisma } = makeUsage();
    const reset = jest.spyOn(service, 'resetMonthlyCounters').mockResolvedValue();
    prisma.teamUsage.count.mockResolvedValueOnce(0);
    await expect(service.catchUpMonthlyReset(now)).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
    prisma.teamUsage.count.mockResolvedValueOnce(4);
    await expect(service.catchUpMonthlyReset(now)).resolves.toBe(true);
    expect(reset).toHaveBeenCalledWith(now);
  });
});

describe('UsageService counter flush', () => {
  it('puts the Redis counters back when the database write fails', async () => {
    const { service, prisma, counters } = makeUsage();
    prisma.team.findUnique.mockResolvedValue({ projects: [], members: [{ id: 'm' }] });
    counters.getdel.mockResolvedValueOnce('40').mockResolvedValueOnce('1000');
    prisma.teamUsage.upsert.mockRejectedValue(new Error('db down'));
    await expect(service.recalculateTeamUsage('t1')).rejects.toThrow('db down');
    expect(counters.incrby).toHaveBeenCalledWith('usage:api_requests:t1', 40);
    expect(counters.incrby).toHaveBeenCalledWith('usage:bandwidth:t1', 1000);
  });

  it('does not touch the counters again when the write succeeds', async () => {
    const { service, prisma, counters } = makeUsage();
    prisma.team.findUnique.mockResolvedValue({ projects: [], members: [] });
    counters.getdel.mockResolvedValueOnce('40').mockResolvedValueOnce('1000');
    await service.recalculateTeamUsage('t1');
    expect(counters.incrby).not.toHaveBeenCalled();
  });
});

describe('UsageService hourly measurements', () => {
  it('measures database sizes and MAU every hour, each step on its own', async () => {
    const { service } = makeUsage();
    const catchUp = jest.spyOn(service, 'catchUpMonthlyReset').mockRejectedValue(new Error('x'));
    const db = jest.spyOn(service, 'refreshProjectDbSizes').mockResolvedValue(3);
    const mau = jest.spyOn(service, 'measureMau').mockResolvedValue(1);
    await expect(service.hourlyMeasurements()).resolves.toBeUndefined();
    expect(catchUp).toHaveBeenCalled();
    expect(db).toHaveBeenCalledWith();
    expect(mau).toHaveBeenCalled();
  });
});

describe('normalizeApiPath (what the usage middleware counts)', () => {
  it.each([
    ['/api/rest/v1/todos?select=*', '/api/rest/v1/todos'],
    ['/rest/v1/todos', '/api/rest/v1/todos'],
    ['/storage/v1/object/public/b/x.png', '/api/storage/v1/object/public/b/x.png'],
    ['/auth/v1/token', '/api/auth/v1/token'],
    ['/p/abc/auth/v1/authorize', '/api/auth/v1/authorize'],
    ['/api/p/abc/rest/v1/t', '/api/rest/v1/t'],
    ['/dashboard', '/dashboard'],
  ])('%s → %s', (input, out) => {
    expect(normalizeApiPath(input)).toBe(out);
  });

  it('counts a bare-host storage download against its project', async () => {
    const prisma = { project: { findUnique: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1' }) } } as any;
    const usage = { trackApiRequest: jest.fn().mockResolvedValue(undefined), trackBandwidth: jest.fn().mockResolvedValue(undefined) } as any;
    const mw = new UsageTrackingMiddleware(prisma, usage);
    clearInterval((mw as any).evictionTimer);
    const req = { originalUrl: '/storage/v1/object/public/b/x.png', url: '/api/storage/v1/object/public/b/x.png', headers: { 'x-project-id': 'p1' } } as any;
    const res = { write: jest.fn(), end: jest.fn() } as any;
    const next = jest.fn();
    await mw.use(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(usage.trackApiRequest).toHaveBeenCalledWith('t1', 'p1');
  });
});
