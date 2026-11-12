import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { UsageService, usageMonthKey } from './usage.service';

function fakeRedis(initial: Record<string, string> = {}) {
  const kv = new Map<string, string>(Object.entries(initial));
  const hll = new Map<string, Set<string>>();
  const client = {
    pfadd: jest.fn(async (key: string, member: string) => {
      const s = hll.get(key) ?? new Set<string>();
      s.add(member);
      hll.set(key, s);
      return 1;
    }),
    pfcount: jest.fn(async (key: string) => hll.get(key)?.size ?? 0),
    expire: jest.fn(async () => 1),
  };
  return {
    kv,
    hll,
    client,
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    getdel: jest.fn(async (k: string) => {
      const v = kv.get(k) ?? null;
      kv.delete(k);
      return v;
    }),
    incr: jest.fn(),
    incrby: jest.fn(),
    expire: jest.fn(),
    mget: jest.fn(async (...keys: string[]) => keys.map((k) => kv.get(k) ?? null)),
    getClient: () => client,
  } as any;
}

describe('UsageService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  describe('getTeamUsage', () => {
    it('reports live project and member counts and this month’s active users', async () => {
      const prisma = {
        teamUsage: {
          upsert: jest.fn().mockResolvedValue({
            teamId: 't1',
            projectCount: 1, // drifted
            memberCount: 5, // drifted
            apiRequestsMonth: 1000,
            bandwidthMonth: BigInt(2048),
            storageBytes: BigInt(0),
            dbSizeBytes: BigInt(0),
            mauCount: 0,
          }),
        },
        project: { count: jest.fn().mockResolvedValue(3) },
        teamMember: { count: jest.fn().mockResolvedValue(2) },
        projectUsage: {
          aggregate: jest.fn().mockResolvedValue({
            _max: { dbSizeCalculatedAt: new Date('2026-10-22T06:00:00Z'), storageCalculatedAt: null },
          }),
        },
      } as any;
      const redis = fakeRedis({ 'usage:api_requests:t1': '76', 'usage:bandwidth:t1': '1024' });
      const usage = new UsageService(prisma, redis, {} as any);
      await usage.trackActiveUser('t1', 'u1', 'p1');
      await usage.trackActiveUser('t1', 'u1', 'p1'); // same person, same month
      await usage.trackActiveUser('t1', 'u2', 'p1');

      const out = await usage.getTeamUsage('t1');
      expect(out.projectCount).toBe(3);
      expect(out.memberCount).toBe(2);
      expect(out.apiRequestsMonth).toBe(1076);
      expect(out.bandwidthMonth).toBe(BigInt(3072));
      expect(out.mauCount).toBe(2);
      expect(out.dbSizeMeasuredAt).toEqual(new Date('2026-10-22T06:00:00Z'));
      expect(out.storageMeasuredAt).toBeNull();
      // Branches and frozen projects hold no slot.
      expect(prisma.project.count).toHaveBeenCalledWith({
        where: { teamId: 't1', status: { notIn: ['DELETED', 'DEACTIVATED'] }, parentProjectId: null },
      });
    });
  });

  it('keys active users by UTC month', async () => {
    const redis = fakeRedis();
    const usage = new UsageService({} as any, redis, {} as any);
    await usage.trackActiveUser('t1', 'u1', 'p1');
    const key = `usage:mau:t1:${usageMonthKey()}`;
    expect(redis.client.pfadd).toHaveBeenCalledWith(key, 'p1:u1');
    expect(usageMonthKey(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(usageMonthKey(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11');
  });

  describe('moveProjectUsage (#180)', () => {
    it('moves the project’s month-to-date usage from the old team to the new one', async () => {
      const rows: Record<string, { apiRequestsMonth: number; bandwidthMonth: bigint }> = {
        old: { apiRequestsMonth: 10_000, bandwidthMonth: BigInt(500_000) },
        new: { apiRequestsMonth: 300, bandwidthMonth: BigInt(1_000) },
      };
      const prisma = {
        projectUsage: {
          // 4,000 stored + 1,000 still live in Redis = 5,000 requests this month.
          upsert: jest.fn(async (args: any) => ({
            apiRequestsMonth: 4_000 + args.update.apiRequestsMonth.increment,
            bandwidthMonth: BigInt(100_000) + args.update.bandwidthMonth.increment,
          })),
        },
        teamUsage: {
          upsert: jest.fn(async (args: any) => {
            const r = rows[args.where.teamId];
            r.apiRequestsMonth += args.update.apiRequestsMonth.increment;
            r.bandwidthMonth += args.update.bandwidthMonth.increment;
            return r;
          }),
          findUnique: jest.fn(async (args: any) => ({ ...rows[args.where.teamId] })),
          update: jest.fn(async (args: any) => Object.assign(rows[args.where.teamId], args.data)),
        },
      } as any;
      const redis = fakeRedis({
        'usage:api_requests:project:p1': '1000',
        'usage:bandwidth:project:p1': '20000',
        'usage:api_requests:old': '76', // not yet flushed for the old team
      });
      const usage = new UsageService(prisma, redis, {} as any);

      await usage.moveProjectUsage('p1', 'old', 'new');

      expect(prisma.projectUsage.upsert.mock.calls[0][0].update.teamId).toBe('new');
      // old: 10,000 + 76 flushed − 5,000 moved
      expect(rows.old.apiRequestsMonth).toBe(5_076);
      expect(rows.old.bandwidthMonth).toBe(BigInt(500_000 - 120_000));
      expect(rows.new.apiRequestsMonth).toBe(5_300);
      expect(rows.new.bandwidthMonth).toBe(BigInt(121_000));
    });

    it('floors the old team at zero instead of going negative', async () => {
      const rows: Record<string, any> = {
        old: { apiRequestsMonth: 10, bandwidthMonth: BigInt(5) },
        new: { apiRequestsMonth: 0, bandwidthMonth: BigInt(0) },
      };
      const prisma = {
        projectUsage: { upsert: jest.fn().mockResolvedValue({ apiRequestsMonth: 50, bandwidthMonth: BigInt(50) }) },
        teamUsage: {
          upsert: jest.fn(async (args: any) => {
            rows[args.where.teamId].apiRequestsMonth += args.update.apiRequestsMonth.increment;
            rows[args.where.teamId].bandwidthMonth += args.update.bandwidthMonth.increment;
          }),
          findUnique: jest.fn(async (args: any) => ({ ...rows[args.where.teamId] })),
          update: jest.fn(async (args: any) => Object.assign(rows[args.where.teamId], args.data)),
        },
      } as any;
      const usage = new UsageService(prisma, fakeRedis(), {} as any);
      await usage.moveProjectUsage('p1', 'old', 'new');
      expect(rows.old).toEqual({ apiRequestsMonth: 0, bandwidthMonth: BigInt(0) });
      expect(rows.new).toEqual({ apiRequestsMonth: 50, bandwidthMonth: BigInt(50) });
    });
  });

  it('recounts instead of adding one, so a repeated call cannot drift the counter', async () => {
    const prisma = {
      project: { count: jest.fn().mockResolvedValue(2) },
      teamMember: { count: jest.fn().mockResolvedValue(4) },
      teamUsage: { upsert: jest.fn().mockResolvedValue({}) },
    } as any;
    const usage = new UsageService(prisma, fakeRedis(), {} as any);
    await usage.decrementProjectCount('t1');
    await usage.decrementProjectCount('t1');
    for (const call of prisma.teamUsage.upsert.mock.calls) {
      expect(call[0].update).toEqual({ projectCount: 2, memberCount: 4 });
    }
  });

  it('closes the month on UTC and records last month’s active users', () => {
    const opts = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', UsageService.prototype.resetMonthlyCounters);
    expect(opts).toEqual(expect.objectContaining({ cronTime: '0 0 1 * *', timeZone: 'UTC' }));
  });
});
