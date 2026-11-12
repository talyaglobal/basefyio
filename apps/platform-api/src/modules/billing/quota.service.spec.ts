import { Logger } from '@nestjs/common';
import { QuotaExceededException, QuotaService } from './quota.service';
import { UsageService } from './usage.service';

/** A sorted set good enough for the slot queue: ZADD, ZRANK, ZREM, range trim. */
function fakeRedisClient() {
  const sets = new Map<string, Map<string, number>>();
  const ordered = (key: string) =>
    [...(sets.get(key) ?? new Map()).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return {
    sets,
    zremrangebyscore: jest.fn(async (key: string, min: number, max: number) => {
      const s = sets.get(key);
      if (!s) return 0;
      let n = 0;
      for (const [m, score] of s) if (score >= min && score <= max) (s.delete(m), n++);
      return n;
    }),
    zadd: jest.fn(async (key: string, score: number, member: string) => {
      const s = sets.get(key) ?? new Map<string, number>();
      s.set(member, score);
      sets.set(key, s);
      return 1;
    }),
    pexpire: jest.fn(async () => 1),
    zrank: jest.fn(async (key: string, member: string) => {
      const i = ordered(key).findIndex(([m]) => m === member);
      return i < 0 ? null : i;
    }),
    zrem: jest.fn(async (key: string, member: string) => (sets.get(key)?.delete(member) ? 1 : 0)),
    pfcount: jest.fn(async () => 0),
  };
}

/**
 * A Free team (2 projects) whose stored counter disagrees with reality —
 * the drift behind #182: restores never added a project back, deleting a
 * deactivated project took one off twice.
 */
function setup(opts: { liveProjects: number; storedProjectCount?: number; maxProjects?: number | null; redisDown?: boolean }) {
  let live = opts.liveProjects;
  const prisma = {
    subscription: {
      findUnique: jest.fn().mockResolvedValue({
        teamId: 't1',
        plan: {
          name: 'free',
          displayName: 'Free',
          maxProjects: opts.maxProjects === undefined ? 2 : opts.maxProjects,
          maxTeamMembers: 2,
          maxStorageBytes: BigInt(1024 ** 3),
          maxBandwidthBytes: BigInt(1024 ** 3),
          maxApiRequests: 50_000,
        },
      }),
    },
    teamUsage: {
      upsert: jest.fn().mockResolvedValue({
        teamId: 't1',
        projectCount: opts.storedProjectCount ?? 0,
        memberCount: 1,
        storageBytes: BigInt(0),
        dbSizeBytes: BigInt(0),
        apiRequestsMonth: 0,
        bandwidthMonth: BigInt(0),
        mauCount: 0,
      }),
    },
    project: { count: jest.fn(async () => live) },
    teamMember: { count: jest.fn().mockResolvedValue(1) },
    projectUsage: { aggregate: jest.fn().mockResolvedValue({ _max: {} }) },
  } as any;
  const client = fakeRedisClient();
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    getClient: jest.fn(() => {
      if (opts.redisDown) throw new Error('redis down');
      return client;
    }),
  } as any;
  const usage = new UsageService(prisma, redis, {} as any);
  const quota = new QuotaService(prisma, usage, redis);
  return { quota, prisma, client, addProject: () => (live += 1) };
}

describe('QuotaService — project limit (#182)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('counts live projects, not the drifted stored counter', async () => {
    // Stored counter says 0, the team really has 2 live projects on a 2-project plan.
    const { quota } = setup({ liveProjects: 2, storedProjectCount: 0 });
    await expect(quota.assertCanCreateProject('t1')).rejects.toBeInstanceOf(QuotaExceededException);
    await expect(quota.reserveProjectSlot('t1')).rejects.toMatchObject({ status: 402 });
  });

  it('still enforces the limit for a team that had no usage row (it used to skip the check)', async () => {
    const { quota, prisma } = setup({ liveProjects: 3 });
    await expect(quota.assertCanCreateProject('t1')).rejects.toBeInstanceOf(QuotaExceededException);
    expect(prisma.teamUsage.upsert).toHaveBeenCalled();
  });

  it('lets exactly one of two simultaneous creations take the last slot', async () => {
    const { quota } = setup({ liveProjects: 1 });
    const results = await Promise.allSettled([quota.reserveProjectSlot('t1'), quota.reserveProjectSlot('t1')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(QuotaExceededException);
  });

  it('frees the slot on release, and the created project then counts itself', async () => {
    const { quota, client, addProject } = setup({ liveProjects: 1 });
    const slot = await quota.reserveProjectSlot('t1');
    expect(client.sets.get('quota:project-slots:t1')!.size).toBe(1);
    addProject(); // the project row is written
    await slot.release();
    await slot.release(); // harmless twice
    expect(client.sets.get('quota:project-slots:t1')!.size).toBe(0);
    // 2 of 2 now: the next creation is refused.
    await expect(quota.reserveProjectSlot('t1')).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it('a refused reservation leaves no slot behind', async () => {
    const { quota, client } = setup({ liveProjects: 2 });
    await expect(quota.reserveProjectSlot('t1')).rejects.toBeInstanceOf(QuotaExceededException);
    expect(client.sets.get('quota:project-slots:t1')!.size).toBe(0);
  });

  it('still enforces the live count when Redis is unavailable', async () => {
    const { quota } = setup({ liveProjects: 2, redisDown: true });
    await expect(quota.reserveProjectSlot('t1')).rejects.toBeInstanceOf(QuotaExceededException);
    const ok = setup({ liveProjects: 1, redisDown: true });
    await expect(ok.quota.reserveProjectSlot('t1')).resolves.toHaveProperty('release');
  });

  it('never limits a plan without a project cap', async () => {
    const { quota, client } = setup({ liveProjects: 500, maxProjects: null });
    const slot = await quota.reserveProjectSlot('t1');
    await slot.release();
    expect(client.zadd).not.toHaveBeenCalled();
  });

  it('summarises the limit for the dashboard', async () => {
    const { quota } = setup({ liveProjects: 3 });
    await expect(quota.getTeamLimitSummary('t1')).resolves.toEqual({
      plan: { name: 'free', displayName: 'Free' },
      projects: { used: 3, limit: 2, canCreate: false },
      members: { used: 1, limit: 2, canInvite: true },
    });
  });

  it('states storage limits in binary units', async () => {
    const { quota } = setup({ liveProjects: 0 });
    await expect(quota.assertCanUploadStorage('t1', 2 * 1024 ** 3)).rejects.toThrow(
      'Your Free plan allows 1 GiB of storage',
    );
  });
});
