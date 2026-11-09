import { TeamsService } from './teams.service';

/**
 * The /api/teams list shape is what the SDK, the CLI and the dashboard
 * switcher read. Organizations add fields to it; they must never rename or
 * drop one.
 */
describe('TeamsService.findAllForUser', () => {
  const membership = {
    role: 'ADMIN',
    team: {
      id: 't1',
      name: 'Acme',
      slug: 'acme',
      personalForUserId: null,
      requireMfa: false,
      publicId: 'bbjhvprglckpgrhazpvx',
      kind: 'COMPANY',
      subscription: { plan: { name: 'pro', displayName: 'Pro' } },
      _count: { members: 3, projects: 2 },
    },
  };

  function makeService(rows: unknown[]) {
    const prisma = { teamMember: { findMany: jest.fn().mockResolvedValue(rows) } };
    return new TeamsService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  }

  it('keeps every field older clients read, in the same shape', async () => {
    const [row] = await makeService([membership]).findAllForUser('u1');
    expect(row).toMatchObject({
      id: 't1',
      name: 'Acme',
      slug: 'acme',
      isPersonal: false,
      role: 'ADMIN',
      memberCount: 3,
      projectCount: 2,
      requireMfa: false,
    });
  });

  it('adds the organization fields', async () => {
    const [row] = await makeService([membership]).findAllForUser('u1');
    expect(row.publicId).toBe('bbjhvprglckpgrhazpvx');
    expect(row.kind).toBe('COMPANY');
    expect(row.plan).toEqual({ name: 'pro', displayName: 'Pro' });
  });

  it('reports no plan rather than failing when a team has no subscription', async () => {
    const [row] = await makeService([{ ...membership, team: { ...membership.team, subscription: null } }]).findAllForUser('u1');
    expect(row.plan).toBeNull();
  });
});

describe('TeamsService.create', () => {
  function makeService(existingSlug: boolean) {
    const prisma = {
      team: {
        findUnique: jest.fn().mockResolvedValue(existingSlug ? { id: 'other' } : null),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 't-new', ...data })),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ email: 'o@example.com' }) },
      teamRolePermission: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const billing = { createFreeSubscription: jest.fn().mockResolvedValue({}) };
    const service = new TeamsService(prisma as any, {} as any, {} as any, {} as any, billing as any, {} as any, {} as any);
    return { service, prisma };
  }

  it('gives a new team a public id and the requested kind', async () => {
    const { service, prisma } = makeService(false);
    await service.create('Acme Agency', 'u1', { kind: 'AGENCY' });
    const data = prisma.team.create.mock.calls[0][0].data;
    expect(data.slug).toBe('acme-agency');
    expect(data.kind).toBe('AGENCY');
    expect(data.publicId).toMatch(/^[a-z0-9]{20}$/);
    expect(data.organizationMigratedAt).toBeInstanceOf(Date);
  });

  it('still 409s on a slug collision for /teams, and suffixes for organizations', async () => {
    await expect(makeService(true).service.create('Acme', 'u1')).rejects.toThrow('Team name already taken');

    const { service, prisma } = makeService(true);
    await service.create('Acme', 'u1', { suffixOnCollision: true });
    expect(prisma.team.create.mock.calls[0][0].data.slug).toMatch(/^acme-[a-z0-9]{4}$/);
  });
});

describe('TeamsService.listTeamInvites / leaveTeam', () => {
  function makeService(memberRole: string, invites: unknown[] = []) {
    const prisma = {
      teamMember: {
        findUnique: jest.fn().mockResolvedValue({ role: memberRole }),
        findMany: jest.fn().mockResolvedValue([{ userId: 'u-boran', user: { email: 'Boran@Example.com' } }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      teamInvite: { findMany: jest.fn().mockResolvedValue(invites) },
    };
    const usage = { decrementMemberCount: jest.fn().mockResolvedValue(undefined) };
    const realtime = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new TeamsService(prisma as any, {} as any, {} as any, usage as any, {} as any, realtime as any, {} as any);
    return { service, prisma };
  }

  it('does not list an invite whose person is already a member', async () => {
    const { service } = makeService('OWNER', [
      { id: 'i1', invitedUserId: null, invitedEmail: 'boran@example.com', invitedUser: null },
      { id: 'i2', invitedUserId: 'u-boran', invitedEmail: null, invitedUser: { id: 'u-boran', email: 'boran@example.com' } },
      { id: 'i3', invitedUserId: null, invitedEmail: 'new@example.com', invitedUser: null },
    ]);
    const list = await service.listTeamInvites('t1', 'u1');
    expect(list.map((i: any) => i.id)).toEqual(['i3']);
    expect(list[0].invitedUser).toEqual({ id: null, email: 'new@example.com' });
  });

  it('lets a member leave, but not the owner', async () => {
    const member = makeService('MEMBER');
    await expect(member.service.leaveTeam('t1', 'u2')).resolves.toEqual({ message: 'You left the team' });
    expect(member.prisma.teamMember.deleteMany).toHaveBeenCalledWith({ where: { teamId: 't1', userId: 'u2' } });

    const owner = makeService('OWNER');
    await expect(owner.service.leaveTeam('t1', 'u1')).rejects.toThrow('Transfer ownership');
    expect(owner.prisma.teamMember.deleteMany).not.toHaveBeenCalled();
  });
});
