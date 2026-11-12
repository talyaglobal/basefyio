jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../teams/teams.service', () => ({ TeamsService: class {} }));

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { MAX_HOLDS_PER_TEAM, TeamDomainsService } from './team-domains.service';
import { SUBDOMAIN_HOLD_DAYS } from './subdomain.util';

const DAY = 24 * 60 * 60 * 1000;

interface Hold {
  subdomain: string;
  teamId: string;
  releasedAt: Date;
  expiresAt: Date;
}

/**
 * An in-memory stand-in for the two tables involved, with just the Prisma
 * calls the service makes. `$transaction` runs the callback against the same
 * store, so a test sees the state the service leaves behind.
 */
function store(teams: { id: string; subdomain: string | null; subdomainUpdatedAt?: Date | null }[], holds: Hold[] = []) {
  const state = { teams: teams.map((t) => ({ subdomainUpdatedAt: null, ...t })), holds: [...holds] };
  const matchHold = (h: Hold, where: any): boolean => {
    if (where.subdomain !== undefined) {
      if (typeof where.subdomain === 'string' && h.subdomain !== where.subdomain) return false;
      if (where.subdomain?.in && !where.subdomain.in.includes(h.subdomain)) return false;
    }
    if (where.teamId !== undefined && h.teamId !== where.teamId) return false;
    if (where.expiresAt?.gt && !(h.expiresAt > where.expiresAt.gt)) return false;
    if (where.expiresAt?.lte && !(h.expiresAt <= where.expiresAt.lte)) return false;
    if (where.OR && !where.OR.some((w: any) => matchHold(h, w))) return false;
    return true;
  };
  const prisma: any = {
    team: {
      findUnique: jest.fn(async ({ where }: any) => {
        const t = where.id
          ? state.teams.find((x) => x.id === where.id)
          : state.teams.find((x) => x.subdomain === where.subdomain);
        return t ? { ...t } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        if (data.subdomain && state.teams.some((x) => x.subdomain === data.subdomain && x.id !== where.id)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const t = state.teams.find((x) => x.id === where.id)!;
        Object.assign(t, data);
        return { ...t };
      }),
    },
    teamSubdomainHold: {
      findUnique: jest.fn(async ({ where }: any) => {
        const h = state.holds.find((x) => x.subdomain === where.subdomain);
        return h ? { ...h } : null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return state.holds
          .filter((h) => matchHold(h, where))
          .sort((a, b) => b.releasedAt.getTime() - a.releasedAt.getTime())
          .map((h) => ({ ...h }));
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = state.holds.length;
        state.holds = state.holds.filter((h) => !matchHold(h, where));
        return { count: before - state.holds.length };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const h = state.holds.find((x) => x.subdomain === where.subdomain);
        if (h) Object.assign(h, update);
        else state.holds.push({ ...create });
        return {};
      }),
    },
    project: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === 'p1' ? { teamId: 't1' } : null)),
    },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: any) => Promise<unknown>) => fn(prisma));
  return { prisma, state };
}

function teamsMock(role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'OWNER') {
  return {
    assertMember: jest.fn(async () => ({ role })),
    assertOwnerOrAdmin: jest.fn(async () => {
      if (role === 'MEMBER') throw new ForbiddenException('Only team owners and admins can do this');
      return { role };
    }),
  };
}

function service(
  prisma: any,
  teams = teamsMock(),
  cfg: Record<string, unknown> = { publicApiUrl: 'https://api.basefyio.com' },
) {
  const config = { get: (k: string) => cfg[k] };
  return new TeamDomainsService(prisma, config as any, teams as any);
}

describe('TeamDomainsService settings', () => {
  it('derives the base domain from the public API URL, or takes TENANT_BASE_DOMAIN', () => {
    const { prisma } = store([]);
    expect(service(prisma).baseDomain()).toBe('basefyio.com');
    expect(service(prisma, teamsMock(), { TENANT_BASE_DOMAIN: 'example.org', publicApiUrl: 'https://api.basefyio.com' }).baseDomain()).toBe('example.org');
    expect(service(prisma, teamsMock(), { publicApiUrl: 'http://localhost:4000' }).baseDomain()).toBeNull();
  });

  it('is not live until TENANT_SUBDOMAINS_LIVE=true', () => {
    const { prisma } = store([]);
    expect(service(prisma).live()).toBe(false);
    expect(service(prisma, teamsMock(), { TENANT_SUBDOMAINS_LIVE: 'true' }).live()).toBe(true);
    expect(service(prisma, teamsMock(), { TENANT_SUBDOMAINS_LIVE: 'yes' }).live()).toBe(false);
  });
});

describe('TeamDomainsService.getForTeam', () => {
  it('describes a claimed address with its API and database host', async () => {
    const { prisma } = store([{ id: 't1', subdomain: 'technoplatz' }]);
    const view = await service(prisma, teamsMock('MEMBER'), {
      publicApiUrl: 'https://api.basefyio.com',
      TENANT_SUBDOMAINS_LIVE: 'true',
      'pgbouncer.externalPort': 6432,
    }).getForTeam('t1', 'u1');
    expect(view).toMatchObject({
      subdomain: 'technoplatz',
      baseDomain: 'basefyio.com',
      live: true,
      host: 'technoplatz.basefyio.com',
      apiUrl: 'https://technoplatz.basefyio.com',
      database: { host: 'technoplatz.basefyio.com', port: 6432 },
      previous: [],
      holdDays: SUBDOMAIN_HOLD_DAYS,
      canManage: false,
    });
  });

  it('has no URLs without a base domain or an address', async () => {
    const { prisma } = store([{ id: 't1', subdomain: null }]);
    const view = await service(prisma).getForTeam('t1', 'u1');
    expect(view).toMatchObject({ subdomain: null, host: null, apiUrl: null, database: null, canManage: true });
  });

  it('refuses a non-member', async () => {
    const { prisma } = store([{ id: 't1', subdomain: null }]);
    const teams = teamsMock();
    teams.assertMember.mockRejectedValue(new ForbiddenException('Not a member of this team'));
    await expect(service(prisma, teams).getForTeam('t1', 'u9')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TeamDomainsService.claim', () => {
  it('claims a free address, stored lower-case', async () => {
    const { prisma, state } = store([{ id: 't1', subdomain: null }]);
    const view = await service(prisma).claim('t1', 'u1', ' TechnoPlatz ');
    expect(view.subdomain).toBe('technoplatz');
    expect(state.teams[0].subdomain).toBe('technoplatz');
    expect(state.teams[0].subdomainUpdatedAt).toBeInstanceOf(Date);
    expect(state.holds).toEqual([]);
  });

  it('refuses an invalid or reserved name with the reason', async () => {
    const { prisma } = store([{ id: 't1', subdomain: null }]);
    await expect(service(prisma).claim('t1', 'u1', 'api')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service(prisma).claim('t1', 'u1', 'no_underscores')).rejects.toMatchObject({
      response: { code: 'SUBDOMAIN_INVALID', reason: 'invalid_characters' },
    });
  });

  it('refuses a member who is not an owner or admin', async () => {
    const { prisma, state } = store([{ id: 't1', subdomain: null }]);
    await expect(service(prisma, teamsMock('MEMBER')).claim('t1', 'u1', 'technoplatz')).rejects.toBeInstanceOf(ForbiddenException);
    expect(state.teams[0].subdomain).toBeNull();
  });

  it("refuses another team's address", async () => {
    const { prisma } = store([
      { id: 't1', subdomain: null },
      { id: 't2', subdomain: 'technoplatz' },
    ]);
    await expect(service(prisma).claim('t1', 'u1', 'technoplatz')).rejects.toMatchObject({
      response: { code: 'SUBDOMAIN_TAKEN' },
    });
  });

  it("refuses an address on hold for another team, until the hold expires", async () => {
    const now = Date.now();
    const { prisma, state } = store(
      [{ id: 't1', subdomain: null }],
      [{ subdomain: 'oldname', teamId: 't2', releasedAt: new Date(now - DAY), expiresAt: new Date(now + DAY) }],
    );
    await expect(service(prisma).claim('t1', 'u1', 'oldname')).rejects.toBeInstanceOf(ConflictException);

    state.holds[0].expiresAt = new Date(now - 1000);
    const view = await service(prisma).claim('t1', 'u1', 'oldname');
    expect(view.subdomain).toBe('oldname');
    expect(state.holds).toEqual([]);
  });

  it('puts the previous address on hold for the same team when it changes', async () => {
    const { prisma, state } = store([{ id: 't1', subdomain: 'first' }]);
    const before = Date.now();
    const view = await service(prisma).claim('t1', 'u1', 'second');
    expect(view.subdomain).toBe('second');
    expect(state.holds).toHaveLength(1);
    expect(state.holds[0]).toMatchObject({ subdomain: 'first', teamId: 't1' });
    const days = (state.holds[0].expiresAt.getTime() - before) / DAY;
    expect(Math.round(days)).toBe(SUBDOMAIN_HOLD_DAYS);
    expect(view.previous.map((p) => p.subdomain)).toEqual(['first']);
  });

  it('lets a team take back its own address from hold', async () => {
    const { prisma, state } = store([{ id: 't1', subdomain: 'first' }]);
    const svc = service(prisma);
    await svc.claim('t1', 'u1', 'second');
    const view = await svc.claim('t1', 'u1', 'first');
    expect(view.subdomain).toBe('first');
    expect(state.holds.map((h) => h.subdomain)).toEqual(['second']);
  });

  it(`keeps at most ${MAX_HOLDS_PER_TEAM} earlier addresses on hold`, async () => {
    const { prisma, state } = store([{ id: 't1', subdomain: 'name-a' }]);
    const svc = service(prisma);
    // Distinct release times, so "most recent" is well defined.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      let t = Date.parse('2026-10-22T10:00:00Z');
      for (const next of ['name-b', 'name-c', 'name-d', 'name-e']) {
        t += 1000;
        jest.setSystemTime(t);
        await svc.claim('t1', 'u1', next);
      }
    } finally {
      jest.useRealTimers();
    }
    expect(state.teams[0].subdomain).toBe('name-e');
    expect(state.holds.map((h) => h.subdomain).sort()).toEqual(['name-b', 'name-c', 'name-d']);
  });

  it('does nothing when the address is already the current one', async () => {
    const { prisma } = store([{ id: 't1', subdomain: 'technoplatz' }]);
    await service(prisma).claim('t1', 'u1', 'technoplatz');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('turns a lost race on the unique index into a conflict', async () => {
    const { prisma } = store([{ id: 't1', subdomain: null }]);
    prisma.team.update.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(service(prisma).claim('t1', 'u1', 'technoplatz')).rejects.toMatchObject({
      response: { code: 'SUBDOMAIN_TAKEN' },
    });
  });
});

describe('TeamDomainsService.release / checkAvailability', () => {
  it('releases the address onto a hold', async () => {
    const { prisma, state } = store([{ id: 't1', subdomain: 'technoplatz' }]);
    const view = await service(prisma).release('t1', 'u1');
    expect(view.subdomain).toBeNull();
    expect(state.holds.map((h) => h.subdomain)).toEqual(['technoplatz']);
  });

  it('reports availability with a reason', async () => {
    const { prisma } = store([
      { id: 't1', subdomain: null },
      { id: 't2', subdomain: 'taken-name' },
    ]);
    const svc = service(prisma, teamsMock('MEMBER'));
    expect(await svc.checkAvailability('t1', 'u1', 'free-name')).toEqual({ subdomain: 'free-name', available: true });
    expect(await svc.checkAvailability('t1', 'u1', 'taken-name')).toMatchObject({ available: false, code: 'taken' });
    expect(await svc.checkAvailability('t1', 'u1', 'www')).toMatchObject({ available: false, code: 'reserved' });
  });
});

describe('TeamDomainsService.resolveLabel', () => {
  it('finds the team holding the address and caches it', async () => {
    const { prisma } = store([{ id: 't1', subdomain: 'technoplatz' }]);
    const svc = service(prisma);
    expect(await svc.resolveLabel('technoplatz')).toEqual({ teamId: 't1', subdomain: 'technoplatz', previous: false });
    expect(await svc.resolveLabel('technoplatz')).toEqual({ teamId: 't1', subdomain: 'technoplatz', previous: false });
    expect(prisma.team.findUnique).toHaveBeenCalledTimes(1);
  });

  it('answers for a held address until the hold expires', async () => {
    const now = Date.now();
    const { prisma } = store(
      [{ id: 't1', subdomain: 'new-name' }],
      [
        { subdomain: 'old-name', teamId: 't1', releasedAt: new Date(now), expiresAt: new Date(now + DAY) },
        { subdomain: 'gone-name', teamId: 't1', releasedAt: new Date(now - 40 * DAY), expiresAt: new Date(now - DAY) },
      ],
    );
    const svc = service(prisma);
    expect(await svc.resolveLabel('old-name')).toEqual({ teamId: 't1', subdomain: 'old-name', previous: true });
    expect(await svc.resolveLabel('gone-name')).toBeNull();
  });

  it('remembers an unknown name briefly and never looks up an unclaimable one', async () => {
    const { prisma } = store([]);
    const svc = service(prisma);
    expect(await svc.resolveLabel('nobody-here')).toBeNull();
    expect(await svc.resolveLabel('nobody-here')).toBeNull();
    expect(prisma.team.findUnique).toHaveBeenCalledTimes(1);

    expect(await svc.resolveLabel('bad_label')).toBeNull();
    expect(await svc.resolveLabel('basefyio-login')).toBeNull();
    expect(prisma.team.findUnique).toHaveBeenCalledTimes(1);
  });

  it('sees a new owner at once after a claim in the same process', async () => {
    const { prisma } = store([{ id: 't1', subdomain: null }]);
    const svc = service(prisma);
    expect(await svc.resolveLabel('technoplatz')).toBeNull();
    await svc.claim('t1', 'u1', 'technoplatz');
    expect(await svc.resolveLabel('technoplatz')).toMatchObject({ teamId: 't1' });
  });

  it('maps a project to its team, null when unknown', async () => {
    const { prisma } = store([]);
    const svc = service(prisma);
    expect(await svc.teamOfProject('p1')).toBe('t1');
    expect(await svc.teamOfProject('p1')).toBe('t1');
    expect(await svc.teamOfProject('nope')).toBeNull();
    expect(prisma.project.findUnique).toHaveBeenCalledTimes(2);
  });
});
