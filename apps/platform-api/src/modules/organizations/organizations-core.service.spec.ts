import { OrganizationsCoreService, personalOrganizationName } from './organizations-core.service';
import { isPublicId } from './public-id';

function makePrisma() {
  return {
    team: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'team-1', ...data })),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    teamRolePermission: { upsert: jest.fn().mockResolvedValue({}) },
  };
}

function makeBilling() {
  return {
    createFreeSubscription: jest.fn().mockResolvedValue({}),
    createSubscriptionWithPlan: jest.fn().mockResolvedValue({}),
  };
}

const input = { userId: 'u-1234567890', email: 'Ada.Lovelace@example.com', firstName: 'Ada', lastName: 'Lovelace' };

describe('personalOrganizationName', () => {
  it('uses the full name, then the email local part', () => {
    expect(personalOrganizationName(input)).toBe("Ada Lovelace's Organization");
    expect(personalOrganizationName({ email: 'grace@example.com' })).toBe("grace's Organization");
  });
});

describe('OrganizationsCoreService.ensurePersonalOrganization', () => {
  it('creates the row, membership, pointer, permissions and the free subscription', async () => {
    const prisma = makePrisma();
    const billing = makeBilling();
    const service = new OrganizationsCoreService(prisma as any, billing as any);

    const team = await service.ensurePersonalOrganization(input);

    const data = prisma.team.create.mock.calls[0][0].data;
    expect(data.name).toBe("Ada Lovelace's Organization");
    expect(data.kind).toBe('PERSONAL');
    expect(data.personalForUserId).toBe('u-1234567890');
    expect(data.slug).toBe('personal-adalovelace-u-123456');
    expect(isPublicId(data.publicId)).toBe(true);
    expect(data.members).toEqual({ create: { userId: 'u-1234567890', role: 'OWNER' } });

    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u-1234567890' }, data: { activeTeamId: 'team-1' } });
    expect(prisma.teamRolePermission.upsert).toHaveBeenCalledTimes(2);
    expect(billing.createFreeSubscription).toHaveBeenCalledWith('team-1', input.email, "Ada Lovelace's Organization");
    expect(billing.createSubscriptionWithPlan).not.toHaveBeenCalled();
    expect(team.id).toBe('team-1');
  });

  it('attaches the chosen paid plan instead of the free one', async () => {
    const prisma = makePrisma();
    const billing = makeBilling();
    const service = new OrganizationsCoreService(prisma as any, billing as any);

    await service.ensurePersonalOrganization({ ...input, planName: 'pro' });

    expect(billing.createSubscriptionWithPlan).toHaveBeenCalledWith('team-1', 'pro', input.email, "Ada Lovelace's Organization");
    expect(billing.createFreeSubscription).not.toHaveBeenCalled();
  });

  it('is idempotent: an existing personal organization is completed, not duplicated', async () => {
    const prisma = makePrisma();
    prisma.team.findUnique
      .mockResolvedValueOnce({ id: 'team-old', publicId: null })
      .mockResolvedValueOnce({ publicId: null });
    const billing = makeBilling();
    const service = new OrganizationsCoreService(prisma as any, billing as any);

    const team = await service.ensurePersonalOrganization(input);

    expect(team.id).toBe('team-old');
    expect(prisma.team.create).not.toHaveBeenCalled();
    expect(billing.createFreeSubscription).not.toHaveBeenCalled();
    const update = prisma.team.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'team-old' });
    expect(isPublicId(update.data.publicId)).toBe(true);
    expect(prisma.teamRolePermission.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u-1234567890', activeTeamId: null },
      data: { activeTeamId: 'team-old' },
    });
  });

  it('keeps the organization when the subscription cannot be created', async () => {
    const prisma = makePrisma();
    const billing = makeBilling();
    billing.createFreeSubscription.mockRejectedValue(new Error('stripe down'));
    const service = new OrganizationsCoreService(prisma as any, billing as any);

    await expect(service.ensurePersonalOrganization(input)).resolves.toMatchObject({ id: 'team-1' });
  });
});

describe('OrganizationsCoreService.addWhatIsMissing', () => {
  it('adds public ids, personal organizations and permission rows, and marks personal kinds', async () => {
    const prisma = makePrisma();
    prisma.team.findMany
      .mockResolvedValueOnce([{ id: 't-no-id' }]) // without public id
      .mockResolvedValueOnce([
        { id: 't-no-id', _count: { rolePermissions: 0 } },
        { id: 't-ok', _count: { rolePermissions: 2 } },
      ]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'u-orphan-1234', email: 'o@example.com', firstName: null, lastName: null }]);
    const billing = makeBilling();
    const service = new OrganizationsCoreService(prisma as any, billing as any);

    const report = await service.addWhatIsMissing();

    expect(report).toEqual({ publicIds: 1, personal: 1, permissions: 1 });
    expect(prisma.team.updateMany).toHaveBeenCalledWith({
      where: { personalForUserId: { not: null }, kind: { not: 'PERSONAL' } },
      data: { kind: 'PERSONAL' },
    });
    expect(prisma.team.create).toHaveBeenCalledTimes(1);
    expect(prisma.team.create.mock.calls[0][0].data.name).toBe("o's Organization");
  });
});
