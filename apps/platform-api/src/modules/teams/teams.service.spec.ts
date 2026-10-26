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
