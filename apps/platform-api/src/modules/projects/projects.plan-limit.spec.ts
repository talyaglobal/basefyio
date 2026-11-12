jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../infrastructure/infrastructure.service', () => ({ InfrastructureService: class {} }));

import { Logger } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { QuotaExceededException } from '../billing/quota.service';

/**
 * #182: a Free team ended up with three live projects although its plan allows
 * two. Creating a project checked the limit; restoring one from the trash and
 * moving one in from another team did not. Both now take a plan slot the way
 * creating and reactivating do — and when refused, change nothing.
 */
function build(over: { reserve?: jest.Mock } = {}) {
  const prisma = {
    project: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ role: 'OWNER' }) },
  };
  const release = jest.fn().mockResolvedValue(undefined);
  const quota = {
    reserveProjectSlot: over.reserve ?? jest.fn().mockResolvedValue({ release }),
  };
  const usageService = {
    moveProjectUsage: jest.fn().mockResolvedValue(undefined),
    syncTeamCounts: jest.fn().mockResolvedValue(undefined),
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  // Built without the constructor so the test does not depend on its argument
  // list; only what restore and moveToTeam touch is provided.
  const svc = Object.create(ProjectsService.prototype) as any;
  Object.assign(svc, {
    prisma,
    quota,
    usageService,
    activity,
    config: { get: jest.fn().mockReturnValue(undefined) },
    logger: new Logger('test'),
  });
  return { svc, prisma, quota, usageService, release };
}

const trashed = {
  id: 'p3',
  name: 'shop_deleted',
  slug: 'shop_deleted',
  status: 'DELETED',
  teamId: 't1',
  createdBy: 'u1',
  parentProjectId: null,
  dbName: 'kb_shop_del1700000000000',
  dbUser: 'u_shop_del1700000000000',
  keycloakRealm: 'bf-shop',
  storagePrefix: null,
};

describe('ProjectsService plan limit on restore and move (#182)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses to restore past the plan limit and leaves the project in the trash', async () => {
    const { svc, prisma } = build({
      reserve: jest.fn().mockRejectedValue(new QuotaExceededException('limit', 'projects')),
    });
    prisma.project.findUnique.mockResolvedValue(trashed);
    prisma.project.findFirst.mockResolvedValue(null); // no name conflict
    const rename = jest.spyOn(svc, 'renameDatabase').mockResolvedValue(undefined);

    const err = await svc.restore('p3', 'u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededException);
    expect((err as QuotaExceededException).getStatus()).toBe(402);
    expect((err as Error).message).toMatch(/stays in the trash/);
    expect(rename).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('holds the slot through the restore and releases it afterwards', async () => {
    const { svc, prisma, quota, release } = build();
    prisma.project.findUnique.mockResolvedValue(trashed);
    prisma.project.findFirst.mockResolvedValue(null);
    const inner = jest.spyOn(svc, 'restoreFromTrash').mockResolvedValue({ message: 'Project restored' });

    await expect(svc.restore('p3', 'u1')).resolves.toEqual({ message: 'Project restored' });
    expect(quota.reserveProjectSlot).toHaveBeenCalledWith('t1');
    expect(inner).toHaveBeenCalledWith(trashed, 'u1', 'shop', 'shop');
    expect(release).toHaveBeenCalled();
  });

  it('releases the slot when the restore itself fails', async () => {
    const { svc, prisma, release } = build();
    prisma.project.findUnique.mockResolvedValue(trashed);
    prisma.project.findFirst.mockResolvedValue(null);
    jest.spyOn(svc, 'restoreFromTrash').mockRejectedValue(new Error('rename failed'));
    await expect(svc.restore('p3', 'u1')).rejects.toThrow('rename failed');
    expect(release).toHaveBeenCalled();
  });

  const live = {
    id: 'p1',
    name: 'marketplace',
    slug: 'marketplace',
    status: 'ACTIVE',
    teamId: 'source',
    parentProjectId: null,
    dbHost: 'db',
    dbPort: 5432,
    parent: null,
    folder: null,
    tags: [],
  };

  it('refuses to move a project into a team that is at its limit', async () => {
    const { svc, prisma, usageService } = build({
      reserve: jest.fn().mockRejectedValue(new QuotaExceededException('limit', 'projects')),
    });
    prisma.project.findFirst.mockResolvedValue(live);
    const err = await svc.moveToTeam('p1', 'target', 'u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededException);
    expect((err as Error).message).toMatch(/target team's plan project limit/);
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(usageService.moveProjectUsage).not.toHaveBeenCalled();
  });

  it('moves the project and its month-to-date usage when the target has room', async () => {
    const { svc, prisma, quota, usageService, release } = build();
    prisma.project.findFirst.mockResolvedValue(live);
    await expect(svc.moveToTeam('p1', 'target', 'u1')).resolves.toEqual({ message: 'Project moved successfully' });
    expect(quota.reserveProjectSlot).toHaveBeenCalledWith('target');
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { teamId: 'target', folderId: null },
    });
    expect(release).toHaveBeenCalled();
    expect(usageService.moveProjectUsage).toHaveBeenCalledWith('p1', 'source', 'target');
  });

  it('does not take a slot for a deactivated project, which holds none', async () => {
    const { svc, prisma, quota } = build();
    prisma.project.findFirst.mockResolvedValue({ ...live, status: 'DEACTIVATED' });
    await svc.moveToTeam('p1', 'target', 'u1');
    expect(quota.reserveProjectSlot).not.toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalled();
  });
});
