jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('../auth/platform-mfa.service', () => ({
  PlatformMfaService: class {},
  mfaUnavailable: () => new Error('unavailable'),
}));
jest.mock('../billing/billing.service', () => ({ BillingService: class {} }));
jest.mock('../billing/quota.service', () => ({ QuotaService: class {} }));
jest.mock('../billing/usage.service', () => ({ UsageService: class {} }));
jest.mock('../../common/realtime/realtime-events.service', () => ({ RealtimeEventsService: class {} }));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TeamsService } from './teams.service';

const TEAM = 'team-1';
const OWNER = 'owner-1';
const ADMIN = 'admin-1';

function makePrisma() {
  const prisma: any = {
    teamMember: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn((args: any) => ({ op: 'member.create', args })),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    teamRolePermission: { findUnique: jest.fn().mockResolvedValue(null) },
    teamInvite: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn((args: any) => ({ op: 'invite.update', args })),
      updateMany: jest.fn((args: any) => {
        const op: any = Promise.resolve({ count: 1 });
        op.op = 'invite.updateMany';
        op.args = args;
        return op;
      }),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ email: 'me@example.com', activeTeamId: null }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    team: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme' }) },
    $transaction: jest.fn(async (ops: any[]) => ops),
  };
  return prisma;
}

function makeService(prisma: any) {
  const email = { sendTeamInvite: jest.fn().mockResolvedValue(undefined) };
  const quota = { assertCanInviteMember: jest.fn().mockResolvedValue(undefined) };
  const usage = {
    incrementMemberCount: jest.fn().mockResolvedValue(undefined),
    decrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };
  const realtime = { publish: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn((key: string) => (key === 'publicApiUrl' ? 'https://api.example.com' : undefined)) };
  const service = new TeamsService(
    prisma,
    email as any,
    quota as any,
    usage as any,
    {} as any,
    realtime as any,
    {} as any,
    config as any,
  );
  return { service, email, usage, realtime };
}

function membership(userId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER') {
  return { teamId: TEAM, userId, role };
}

describe('TeamsService — members and invites', () => {
  it('lists members with a short avatar link instead of the inline image', async () => {
    const prisma = makePrisma();
    const inline = `data:image/png;base64,${Buffer.alloc(90_000).toString('base64')}`;
    prisma.teamMember.findUnique.mockResolvedValue(membership(OWNER, 'OWNER'));
    prisma.teamMember.findMany.mockResolvedValue([
      {
        role: 'OWNER',
        createdAt: new Date(),
        user: { id: OWNER, email: 'o@example.com', firstName: 'O', lastName: 'W', avatarUrl: inline },
      },
    ]);
    const { service } = makeService(prisma);
    const [m] = await service.listMembers(TEAM, OWNER);
    expect(m.avatarUrl).toMatch(/^https:\/\/api\.example\.com\/api\/avatars\/owner-1\/[a-f0-9]{20}$/);
    expect(JSON.stringify(m).length).toBeLessThan(500);
  });

  it('hides and settles a pending invite for someone who is already a member', async () => {
    const prisma = makePrisma();
    prisma.teamMember.findUnique.mockResolvedValue(membership(OWNER, 'OWNER'));
    prisma.teamInvite.findMany.mockResolvedValue([
      { id: 'inv-stale', teamId: TEAM, invitedUserId: null, invitedEmail: 'boran@example.com', invitedUser: null, status: 'PENDING' },
      { id: 'inv-open', teamId: TEAM, invitedUserId: null, invitedEmail: 'new@example.com', invitedUser: null, status: 'PENDING' },
    ]);
    prisma.teamMember.findMany.mockResolvedValue([
      { userId: OWNER, user: { email: 'owner@example.com' } },
      { userId: 'u-boran', user: { email: 'Boran@Example.com' } },
    ]);
    const { service } = makeService(prisma);

    const invites = await service.listTeamInvites(TEAM, OWNER);

    expect(invites.map((i) => i.id)).toEqual(['inv-open']);
    expect(invites[0].invitedUser).toEqual({ id: null, email: 'new@example.com' });
    expect(prisma.teamInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['inv-stale'] }, status: 'PENDING' }, data: { status: 'ACCEPTED' } }),
    );
  });

  it('shows an email invite as registered once that address has an account, and links it', async () => {
    const prisma = makePrisma();
    prisma.teamMember.findUnique.mockResolvedValue(membership(OWNER, 'OWNER'));
    prisma.teamInvite.findMany
      .mockResolvedValueOnce([
        { id: 'inv-1', teamId: TEAM, invitedUserId: null, invitedEmail: 'later@example.com', invitedUser: null, status: 'PENDING' },
      ])
      .mockResolvedValueOnce([{ id: 'inv-1' }]);
    prisma.teamMember.findMany.mockResolvedValue([{ userId: OWNER, user: { email: 'owner@example.com' } }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u-later', email: 'Later@example.com' }]);
    const { service } = makeService(prisma);

    const invites = await service.listTeamInvites(TEAM, OWNER);

    expect(invites[0].invitedUser).toEqual({ id: 'u-later', email: 'Later@example.com' });
    expect(prisma.teamInvite.update).toHaveBeenCalledWith({ where: { id: 'inv-1' }, data: { invitedUserId: 'u-later' } });
  });

  it('looks invitees up by email case-insensitively', async () => {
    const prisma = makePrisma();
    prisma.teamMember.findUnique
      .mockResolvedValueOnce(membership(OWNER, 'OWNER'))
      .mockResolvedValueOnce(null);
    prisma.user.findFirst.mockResolvedValue({ id: 'u-2', email: 'Mixed@Case.com', firstName: null, lastName: null });
    const { service } = makeService(prisma);

    await service.sendInvite(TEAM, OWNER, '  mixed@case.com ');

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'mixed@case.com', mode: 'insensitive' } },
    });
    expect(prisma.teamInvite.create).toHaveBeenCalledWith({
      data: { teamId: TEAM, invitedUserId: 'u-2', invitedById: OWNER, role: 'MEMBER' },
    });
  });

  it('lets only the owner invite someone as an admin', async () => {
    const prisma = makePrisma();
    prisma.teamMember.findUnique.mockResolvedValue(membership(ADMIN, 'ADMIN'));
    const { service } = makeService(prisma);
    await expect(service.sendInvite(TEAM, ADMIN, 'x@example.com', 'ADMIN')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.sendInvite(TEAM, ADMIN, 'x@example.com', 'OWNER')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the invited role and grants it on accept', async () => {
    const prisma = makePrisma();
    prisma.teamMember.findUnique
      .mockResolvedValueOnce(membership(OWNER, 'OWNER'))
      .mockResolvedValueOnce(null);
    const { service } = makeService(prisma);
    await service.sendInvite(TEAM, OWNER, 'new@example.com', 'admin');
    expect(prisma.teamInvite.create).toHaveBeenCalledWith({
      data: { teamId: TEAM, invitedEmail: 'new@example.com', invitedById: OWNER, role: 'ADMIN' },
    });

    const accept = makePrisma();
    accept.teamInvite.findFirst.mockResolvedValue({ id: 'inv-9', teamId: TEAM, role: 'ADMIN' });
    accept.teamMember.findUnique.mockResolvedValue(null);
    const { service: svc2, usage } = makeService(accept);
    await svc2.acceptInvite('inv-9', 'u-9');
    const ops = accept.$transaction.mock.calls[0][0];
    expect(ops.find((o: any) => o.op === 'member.create').args.data).toEqual({ teamId: TEAM, userId: 'u-9', role: 'ADMIN' });
    expect(ops.find((o: any) => o.op === 'invite.updateMany').args.where).toEqual(
      expect.objectContaining({ teamId: TEAM, status: 'PENDING', id: { not: 'inv-9' } }),
    );
    expect(usage.incrementMemberCount).toHaveBeenCalledWith(TEAM);
  });

  it('does not create a duplicate membership when the invitee already joined', async () => {
    const prisma = makePrisma();
    prisma.teamInvite.findFirst.mockResolvedValue({ id: 'inv-9', teamId: TEAM, role: 'MEMBER' });
    prisma.teamMember.findUnique.mockResolvedValue(membership('u-9', 'MEMBER'));
    const { service, usage } = makeService(prisma);
    await service.acceptInvite('inv-9', 'u-9');
    const ops = prisma.$transaction.mock.calls[0][0];
    expect(ops.some((o: any) => o.op === 'member.create')).toBe(false);
    expect(usage.incrementMemberCount).not.toHaveBeenCalled();
  });
});

describe('TeamsService.leaveTeam', () => {
  it('refuses the owner', async () => {
    const prisma = makePrisma();
    prisma.teamMember.findUnique.mockResolvedValue(membership(OWNER, 'OWNER'));
    const { service } = makeService(prisma);
    await expect(service.leaveTeam(TEAM, OWNER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.teamMember.deleteMany).not.toHaveBeenCalled();
  });

  it('removes a member and moves their active team elsewhere', async () => {
    const prisma = makePrisma();
    prisma.teamMember.findUnique.mockResolvedValue(membership('u-3', 'MEMBER'));
    prisma.user.findUnique.mockResolvedValue({ activeTeamId: TEAM });
    prisma.teamMember.findFirst.mockResolvedValue({ teamId: 'personal-3' });
    const { service, usage } = makeService(prisma);

    await expect(service.leaveTeam(TEAM, 'u-3')).resolves.toEqual({ message: 'You left the team' });

    expect(prisma.teamMember.deleteMany).toHaveBeenCalledWith({ where: { teamId: TEAM, userId: 'u-3' } });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u-3' }, data: { activeTeamId: 'personal-3' } });
    expect(usage.decrementMemberCount).toHaveBeenCalledWith(TEAM);
  });

  it('refuses someone who is not a member', async () => {
    const prisma = makePrisma();
    prisma.teamMember.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);
    await expect(service.leaveTeam(TEAM, 'stranger')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
