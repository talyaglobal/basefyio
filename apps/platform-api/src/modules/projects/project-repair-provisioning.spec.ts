import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

/**
 * repairProvisioning() is exercised on its own: the service's constructor pulls
 * in a dozen collaborators this method never touches, so the instance is built
 * from the prototype with only the parts it actually uses.
 */

const SHARED = { host: 'postgres', port: 5432 };

function build(opts: {
  project?: Record<string, unknown> | null;
  databases?: string[];
  realmExists?: boolean;
  realmThrows?: boolean;
}) {
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  const databases = new Set(opts.databases ?? []);

  const svc: any = Object.create(ProjectsService.prototype);
  svc.logger = { log: () => {}, warn: () => {}, error: () => {} };
  svc.config = {
    get: (k: string) => ({ 'database.host': SHARED.host, 'database.port': SHARED.port } as any)[k],
  };
  svc.prisma = {
    project: {
      findFirst: async () => (opts.project === undefined ? defaultProject() : opts.project),
      update: async ({ data }: any) => {
        updates.push(data);
        return data;
      },
    },
  };
  svc.getAdminPool = () => ({
    query: async (_sql: string, params: string[]) => {
      const rows = databases.has(params[0]) ? [{ datname: params[0] }] : [];
      return { rows, rowCount: rows.length };
    },
  });
  svc.createDatabase = async (name: string) => {
    calls.push(`createDatabase:${name}`);
    databases.add(name);
  };
  svc.createDatabaseUser = async (user: string) => void calls.push(`createDatabaseUser:${user}`);
  svc.applyRlsBootstrap = async (db: string) => void calls.push(`applyRlsBootstrap:${db}`);
  svc.keycloak = {
    realmExists: async () => {
      if (opts.realmThrows) throw new Error('keycloak unreachable');
      return opts.realmExists ?? true;
    },
    createRealm: async (realm: string) => void calls.push(`createRealm:${realm}`),
    createClients: async (realm: string) => {
      calls.push(`createClients:${realm}`);
      return { anonKey: 'anon-new', serviceKey: 'service-new' };
    },
  };
  svc.activity = { append: async (_id: string, entry: any) => void activity.push(entry) };
  return { svc: svc as ProjectsService, calls, updates, activity };
}

const defaultProject = () => ({
  id: 'proj-1',
  slug: 'broken',
  dbName: 'kb_broken',
  dbHost: SHARED.host,
  dbPort: SHARED.port,
  dbUser: 'kb_user_broken',
  dbPassword: 'secret',
  keycloakRealm: 'kb-broken',
});

describe('ProjectsService.repairProvisioning', () => {
  it('creates the database, its user and the RLS bootstrap when the database is gone', async () => {
    const { svc, calls } = build({ databases: [], realmExists: true });
    const result = await svc.repairProvisioning('proj-1');
    expect(calls).toEqual([
      'createDatabase:kb_broken',
      'createDatabaseUser:kb_user_broken',
      'applyRlsBootstrap:kb_broken',
    ]);
    expect(result.created).toContain('database');
    expect(result.alreadyPresent).toContain('authentication realm');
    expect(result.keysRotated).toBe(false);
  });

  it('creates the realm and reissues the keys when the realm is gone', async () => {
    const { svc, calls, updates } = build({ databases: ['kb_broken'], realmExists: false });
    const result = await svc.repairProvisioning('proj-1');
    expect(calls).toEqual(['createRealm:kb-broken', 'createClients:kb-broken']);
    expect(updates).toEqual([{ anonKey: 'anon-new', serviceKey: 'service-new' }]);
    expect(result.keysRotated).toBe(true);
    expect(result.alreadyPresent).toContain('database');
  });

  it('restores both halves for a project that has neither', async () => {
    const { svc, result, calls } = { ...build({ databases: [], realmExists: false }), result: null as any };
    const out = await svc.repairProvisioning('proj-1');
    expect(calls).toEqual([
      'createDatabase:kb_broken',
      'createDatabaseUser:kb_user_broken',
      'applyRlsBootstrap:kb_broken',
      'createRealm:kb-broken',
      'createClients:kb-broken',
    ]);
    expect(out.created).toHaveLength(5);
    void result;
  });

  it('changes nothing when both are already there', async () => {
    const { svc, calls, updates, activity } = build({ databases: ['kb_broken'], realmExists: true });
    const result = await svc.repairProvisioning('proj-1');
    expect(calls).toEqual([]);
    expect(updates).toEqual([]);
    expect(activity).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.alreadyPresent).toEqual(['database', 'authentication realm']);
  });

  it('leaves the realm alone when Keycloak cannot be reached, rather than recreating it', async () => {
    const { svc, calls } = build({ databases: ['kb_broken'], realmThrows: true });
    const result = await svc.repairProvisioning('proj-1');
    expect(calls).toEqual([]);
    expect(result.keysRotated).toBe(false);
  });

  it('records what it did on the project timeline', async () => {
    const { svc, activity } = build({ databases: [], realmExists: false });
    await svc.repairProvisioning('proj-1');
    expect(activity).toHaveLength(1);
    expect(activity[0].title).toBe('Missing infrastructure restored');
    expect(String(activity[0].detail)).toContain('API keys were reissued');
  });

  it('refuses a project on a dedicated database host', async () => {
    const { svc } = build({ project: { ...defaultProject(), dbHost: 'bf-pg-proj-1', dbPort: 5432 } });
    await expect(svc.repairProvisioning('proj-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an unknown or deleted project', async () => {
    const { svc } = build({ project: null });
    await expect(svc.repairProvisioning('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
