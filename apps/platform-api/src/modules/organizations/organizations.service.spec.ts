import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OrganizationsService, ORGANIZATION_KINDS } from './organizations.service';

const PUBLIC_ID = 'bbjhvprglckpgrhazpvx';
const UUID = '2c2d9e3e-2b4b-4a5d-9c8e-1f2a3b4c5d6e';

const row = {
  id: UUID,
  publicId: PUBLIC_ID,
  name: 'Acme',
  slug: 'acme',
  kind: 'COMPANY',
  personalForUserId: null,
  description: null,
  websiteUrl: null,
  logoUrl: null,
  createdAt: new Date('2026-10-26T00:00:00Z'),
  requireMfa: false,
};

function makePrisma() {
  return {
    team: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue(row),
    },
    plan: { findUnique: jest.fn() },
    project: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([
        { teamId: UUID, status: 'ACTIVE', _count: { _all: 2 } },
        { teamId: UUID, status: 'PAUSED', _count: { _all: 1 } },
      ]),
    },
  };
}

function makeTeams() {
  return {
    findAllForUser: jest.fn().mockResolvedValue([{ id: UUID, publicId: PUBLIC_ID, name: 'Acme' }, { id: 'legacy', publicId: null, name: 'Old' }]),
    create: jest.fn().mockResolvedValue(row),
    assertMember: jest.fn().mockResolvedValue({ role: 'MEMBER' }),
    assertPermission: jest.fn().mockResolvedValue({ role: 'ADMIN' }),
    updateTeamName: jest.fn().mockResolvedValue(row),
    setActiveTeam: jest.fn().mockResolvedValue({ activeTeamId: UUID }),
    listMembers: jest.fn().mockResolvedValue([]),
    listTeamInvites: jest.fn().mockResolvedValue([]),
  };
}

function makeBilling() {
  return {
    createCheckoutSession: jest.fn().mockResolvedValue({ url: 'https://checkout.example/s', sessionId: 'cs_1' }),
    getTeamSubscriptionForUser: jest.fn().mockResolvedValue({ plan: { name: 'free' } }),
  };
}

const usage = { getTeamUsage: jest.fn().mockResolvedValue(null) };

function makeService(prisma: any, teams: any, billing: any = makeBilling()) {
  return new OrganizationsService(prisma, teams, billing, usage as any);
}

describe('OrganizationsService', () => {
  it('does not offer PERSONAL as a kind to pick', () => {
    expect(ORGANIZATION_KINDS).not.toContain('PERSONAL');
    expect(ORGANIZATION_KINDS).toContain('COMPANY');
  });

  describe('resolve', () => {
    it('looks a public id up by public id and a uuid by id', async () => {
      const prisma = makePrisma();
      prisma.team.findUnique.mockResolvedValue({ id: UUID, publicId: PUBLIC_ID });
      const service = makeService(prisma, makeTeams());

      await service.resolve(PUBLIC_ID);
      expect(prisma.team.findUnique.mock.calls[0][0].where).toEqual({ publicId: PUBLIC_ID });

      await service.resolve(UUID);
      expect(prisma.team.findUnique.mock.calls[1][0].where).toEqual({ id: UUID });
    });

    it('404s when nothing matches', async () => {
      const prisma = makePrisma();
      prisma.team.findUnique.mockResolvedValue(null);
      const service = makeService(prisma, makeTeams());
      await expect(service.resolve(PUBLIC_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('lists with an organizationId that falls back to the uuid', async () => {
    const service = makeService(makePrisma(), makeTeams());
    const list = await service.listForUser('u1');
    expect(list.map((o) => o.organizationId)).toEqual([PUBLIC_ID, 'legacy']);
    expect(list[0].projects).toEqual({ awake: 2, deactivated: 1 });
    expect(list[1].projects).toEqual({ awake: 0, deactivated: 0 });
  });

  describe('create', () => {
    it('passes the kind to the teams service and reports the public id', async () => {
      const teams = makeTeams();
      const service = makeService(makePrisma(), teams);

      const result = await service.create('u1', { name: '  Acme ', kind: 'AGENCY' });

      expect(teams.create).toHaveBeenCalledWith('Acme', 'u1', { kind: 'AGENCY', suffixOnCollision: true });
      expect(result.organization.organizationId).toBe(PUBLIC_ID);
      expect(result.checkoutRequired).toBeNull();
    });

    it('rejects a kind that is not selectable and a plan that is not public', async () => {
      const prisma = makePrisma();
      prisma.plan.findUnique.mockResolvedValue({ name: 'secret', isPublic: false });
      const teams = makeTeams();
      const service = makeService(prisma, teams);

      await expect(service.create('u1', { name: 'Acme', kind: 'PERSONAL' as any })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create('u1', { name: 'Acme', planName: 'secret' })).rejects.toBeInstanceOf(BadRequestException);
      expect(teams.create).not.toHaveBeenCalled();
    });

    it('asks for checkout when a public paid plan is chosen', async () => {
      const prisma = makePrisma();
      prisma.plan.findUnique.mockResolvedValue({ name: 'pro', isPublic: true });
      const service = makeService(prisma, makeTeams());

      const result = await service.create('u1', { name: 'Acme', planName: 'pro' });
      expect(result.checkoutRequired).toEqual({ planName: 'pro' });
    });

    it('opens a Stripe checkout for the paid plan when the return urls are given', async () => {
      const prisma = makePrisma();
      prisma.plan.findUnique.mockResolvedValue({ name: 'pro', isPublic: true });
      const billing = makeBilling();
      const service = makeService(prisma, makeTeams(), billing);

      const result = await service.create('u1', {
        name: 'Acme',
        planName: 'pro',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/no',
      });

      expect(billing.createCheckoutSession).toHaveBeenCalledWith(UUID, 'u1', 'pro', 'https://app.example/ok', 'https://app.example/no');
      expect(result.checkoutUrl).toBe('https://checkout.example/s');
      expect(result.organization.organizationId).toBe(PUBLIC_ID);
    });
  });

  describe('update', () => {
    it('refuses to change the kind of a personal organization', async () => {
      const prisma = makePrisma();
      prisma.team.findUnique
        .mockResolvedValueOnce({ id: UUID, publicId: PUBLIC_ID })
        .mockResolvedValueOnce({ personalForUserId: 'u1' });
      const service = makeService(prisma, makeTeams());

      await expect(service.update(PUBLIC_ID, 'u1', { kind: 'AGENCY' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('renames through the teams service and writes the profile fields itself', async () => {
      const prisma = makePrisma();
      prisma.team.findUnique
        .mockResolvedValueOnce({ id: UUID, publicId: PUBLIC_ID })
        .mockResolvedValueOnce({ personalForUserId: null });
      const teams = makeTeams();
      const service = makeService(prisma, teams);

      await service.update(PUBLIC_ID, 'u1', { name: 'Acme Ltd', websiteUrl: 'https://acme.example' });

      expect(teams.assertPermission).toHaveBeenCalledWith(UUID, 'u1', 'canRenameTeam');
      expect(teams.updateTeamName).toHaveBeenCalledWith(UUID, 'u1', 'Acme Ltd');
      expect(prisma.team.update).toHaveBeenCalledWith({ where: { id: UUID }, data: { websiteUrl: 'https://acme.example' } });
    });
  });
});
