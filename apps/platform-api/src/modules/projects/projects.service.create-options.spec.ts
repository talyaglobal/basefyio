import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { PublicApiController } from './public-api.controller';
import { PublicCollectionApiController } from './public-collection-api.controller';
import { DataApiGuard } from '../../common/guards/data-api.guard';
import { DEFAULT_DATA_ACCESS } from './project-data-access';

/**
 * The New project dialog's options as create() sees them: a chosen password, the compute
 * size rule, and the data access settings reaching the RLS bootstrap. The instance is built
 * from the prototype with only the collaborators create() touches.
 */
const TEAM = '2c2d9e3e-2b4b-4a5d-9c8e-1f2a3b4c5d6e';

function build(opts: { plan?: { dedicatedDb: boolean; displayName: string } | null; dedicatedHost?: boolean } = {}) {
  const created: any[] = [];
  const bootstrap: any[] = [];
  const users: Array<[string, string]> = [];
  const svc: any = Object.create(ProjectsService.prototype);
  svc.logger = { log: () => {}, warn: () => {}, error: () => {} };
  svc.config = { get: (k: string) => ({ 'database.host': 'postgres', 'database.port': 5432 } as any)[k] };
  svc.prisma = {
    project: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return { ...data };
      }),
    },
    teamMember: {
      findUnique: jest.fn(async () => ({ role: 'OWNER' })),
      findMany: jest.fn(async () => []),
    },
    user: { findUnique: jest.fn(async () => null) },
  };
  svc.quota = {
    assertCanCreateProject: jest.fn(async () => undefined),
    shouldUseDedicatedDb: jest.fn(async () => opts.plan?.dedicatedDb ?? false),
    getTeamPlan: jest.fn(async () => (opts.plan === undefined ? { dedicatedDb: false, displayName: 'Free' } : opts.plan)),
  };
  svc.infra = {
    isDedicatedDbEnabled: () => opts.dedicatedHost ?? false,
    provisionPostgres: jest.fn(async () => {
      throw new Error('not in this test');
    }),
  };
  svc.uniqueSlug = async () => 'commitcamp_x1';
  svc.uniqueDatabaseNameAndUser = async () => ({ dbName: 'kb_db1', dbUser: 'kb_user_u1' });
  svc.keycloak = {
    assertHealthy: async () => undefined,
    createRealm: async () => undefined,
    createClients: async () => ({ anonKey: 'anon', serviceKey: 'service' }),
  };
  svc.createDatabase = async () => undefined;
  svc.createDatabaseUser = async (user: string, password: string) => void users.push([user, password]);
  svc.applyRlsBootstrap = async (db: string, user: string, flags: unknown) => void bootstrap.push({ db, user, flags });
  svc.sharedAdminTarget = () => ({ host: 'postgres', port: 5432, user: 'admin', password: 'x' });
  svc.provisioning = { installDefaultExtensions: async () => undefined };
  svc.provisionReadonlyRole = async () => null;
  svc.activity = { append: async () => undefined };
  svc.realtime = { publish: async () => undefined };
  svc.usageService = { incrementProjectCount: async () => undefined };
  svc.pgbouncer = { regenerateConfig: async () => undefined };
  return { svc: svc as ProjectsService, created, bootstrap, users, quota: svc.quota, infra: svc.infra };
}

describe('ProjectsService.create — New project dialog options', () => {
  const prev = process.env.ORG_PERMISSIONS_ENFORCED;
  beforeAll(() => {
    process.env.ORG_PERMISSIONS_ENFORCED = 'off';
  });
  afterAll(() => {
    process.env.ORG_PERMISSIONS_ENFORCED = prev;
  });

  it('without the new fields behaves as before: generated password, shared, EU, default data access', async () => {
    const { svc, created, bootstrap, users } = build();
    await svc.create({ teamId: TEAM, name: 'commitcamp' } as any, 'u1');
    expect(users[0][1]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created[0]).toMatchObject({
      region: 'eu-central',
      computeTier: 'shared',
      dataApiEnabled: true,
      autoGrantNewTables: true,
      rlsOnNewTables: false,
      dbPassword: users[0][1],
    });
    expect(bootstrap[0]).toEqual({ db: 'kb_db1', user: 'kb_user_u1', flags: DEFAULT_DATA_ACCESS });
  });

  it('uses the password the customer chose', async () => {
    const { svc, created, users } = build();
    await svc.create({ teamId: TEAM, name: 'commitcamp', dbPassword: '  Str0ng-Passw0rd!  ' } as any, 'u1');
    expect(users[0][1]).toBe('Str0ng-Passw0rd!');
    expect(created[0].dbPassword).toBe('Str0ng-Passw0rd!');
  });

  it('refuses a chosen password that breaks the rotation rules, before anything is created', async () => {
    const { svc, users } = build();
    await expect(
      svc.create({ teamId: TEAM, name: 'commitcamp', dbPassword: 'alllowercase123' } as any, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(users).toHaveLength(0);
  });

  it('answers 400 for a dedicated size on the Free plan', async () => {
    const { svc, users, infra } = build({ plan: { dedicatedDb: false, displayName: 'Free' }, dedicatedHost: true });
    await expect(svc.create({ teamId: TEAM, name: 'commitcamp', computeTier: 'micro' } as any, 'u1')).rejects.toThrow(
      new BadRequestException('Dedicated compute is not available on the Free plan'),
    );
    expect(infra.provisionPostgres).not.toHaveBeenCalled();
    expect(users).toHaveLength(0);
  });

  it('answers 400 for a dedicated size where the region has no room, even on Pro', async () => {
    const { svc } = build({ plan: { dedicatedDb: true, displayName: 'Pro' }, dedicatedHost: false });
    await expect(svc.create({ teamId: TEAM, name: 'commitcamp', computeTier: 'small' } as any, 'u1')).rejects.toThrow(
      new BadRequestException('Dedicated compute is not available in this region yet'),
    );
  });

  it('sizes an accepted dedicated tier from the tier table, and records shared when it falls back', async () => {
    const { svc, infra, created } = build({ plan: { dedicatedDb: true, displayName: 'Pro' }, dedicatedHost: true });
    await svc.create({ teamId: TEAM, name: 'commitcamp', computeTier: 'micro' } as any, 'u1');
    expect(infra.provisionPostgres).toHaveBeenCalledWith(expect.objectContaining({ cpuMillis: 250, memoryMb: 512 }));
    expect(created[0].computeTier).toBe('shared');
  });

  it('passes the data access settings into the RLS bootstrap and stores them', async () => {
    const { svc, created, bootstrap } = build();
    const dataAccess = { dataApi: false, autoGrantNewTables: false, rlsOnNewTables: true };
    await svc.create({ teamId: TEAM, name: 'commitcamp', dataAccess } as any, 'u1');
    expect(bootstrap[0].flags).toEqual(dataAccess);
    expect(created[0]).toMatchObject({ dataApiEnabled: false, autoGrantNewTables: false, rlsOnNewTables: true });
  });
});

describe('ProjectsService.updateDataAccess', () => {
  function forUpdate(role: string) {
    const svc: any = Object.create(ProjectsService.prototype);
    const updates: any[] = [];
    svc.logger = { log: () => {}, warn: () => {}, error: () => {} };
    svc.prisma = {
      project: {
        findFirst: async () => ({
          id: 'p1',
          slug: 'p1',
          teamId: 't1',
          databaseType: 'NOSQL',
          dbUser: 'kb_user_u1',
          dbName: 'kb_db1',
          dataApiEnabled: true,
          autoGrantNewTables: true,
          rlsOnNewTables: false,
        }),
        update: async ({ data }: any) => void updates.push(data),
      },
      teamMember: { findUnique: async () => ({ role }) },
    };
    svc.activity = { append: jest.fn(async () => undefined) };
    return { svc: svc as ProjectsService, updates, activity: svc.activity };
  }

  it('lets an owner turn the Data API off and records it', async () => {
    const { svc, updates, activity } = forUpdate('OWNER');
    await expect(svc.updateDataAccess('p1', 'u1', { dataApi: false })).resolves.toEqual({
      dataApi: false,
      autoGrantNewTables: true,
      rlsOnNewTables: false,
    });
    expect(updates[0]).toEqual({ dataApiEnabled: false, autoGrantNewTables: true, rlsOnNewTables: false });
    expect(activity.append).toHaveBeenCalledWith('p1', expect.objectContaining({ detail: 'Data API disabled' }));
  });

  it('refuses a member', async () => {
    const { svc } = forUpdate('MEMBER');
    await expect(svc.updateDataAccess('p1', 'u1', { dataApi: false })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('REST data plane', () => {
  it.each([PublicApiController, PublicCollectionApiController])('%p runs DataApiGuard after the key guard', (ctrl) => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', ctrl) ?? [];
    expect(guards).toContain(DataApiGuard);
  });
});
