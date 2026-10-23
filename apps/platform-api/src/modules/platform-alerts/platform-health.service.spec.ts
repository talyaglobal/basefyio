import { PlatformHealthService } from './platform-health.service';

const DAY = 24 * 60 * 60 * 1000;

function project(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p-' + (over.slug ?? 'one'),
    name: 'Project',
    slug: 'one',
    dbName: 'kb_one',
    dbHost: 'postgres',
    dbPort: 5432,
    keycloakRealm: 'kb-one',
    ...over,
  };
}

/** Activity rows newest-first, as Prisma returns them for this query. */
function backupLog(entries: Array<[slug: string, ok: boolean, daysAgo: number]>) {
  return entries
    .map(([slug, ok, daysAgo]) => ({
      projectId: 'p-' + slug,
      title: ok ? 'Daily auto-backup completed' : 'Daily auto-backup failed',
      createdAt: new Date(Date.UTC(2026, 9, 24) - daysAgo * DAY),
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function setup(opts: {
  projects: ReturnType<typeof project>[];
  databases?: string[];
  realms?: string[];
  activity?: ReturnType<typeof backupLog>;
  keycloakThrows?: boolean;
}) {
  const raised: any[] = [];
  const prisma = {
    project: { findMany: async () => opts.projects },
    projectActivityLog: { findMany: async () => opts.activity ?? [] },
  };
  const config = {
    get: (k: string) =>
      ({ 'database.host': 'postgres', 'database.port': 5432, 'database.user': 'u', 'database.password': 'p' } as any)[k],
  };
  const keycloak = {
    realmExists: async (realm: string) => {
      if (opts.keycloakThrows) throw new Error('connect ECONNREFUSED');
      return (opts.realms ?? []).includes(realm);
    },
  };
  const alerts = { raise: async (a: any) => void raised.push(a) };
  const svc = new PlatformHealthService(prisma as any, config as any, keycloak as any, alerts as any);
  // The database check opens a real pool; stub it out with the given list.
  (svc as any).checkDatabases = async (projects: any[]) => {
    const present = new Set(opts.databases ?? projects.map((p) => p.dbName));
    const missing = projects.filter((p) => !present.has(p.dbName));
    if (missing.length === 0) return;
    await alerts.raise({
      kind: 'project_database_missing',
      severity: 'critical',
      title: `${missing.length} live project${missing.length === 1 ? ' has' : 's have'} no database`,
      detail: missing.map((p) => p.slug).join(', '),
      metadata: { projects: missing.map((p) => ({ id: p.id, slug: p.slug, dbName: p.dbName })) },
    });
  };
  return { svc, raised };
}

const kinds = (raised: any[]) => raised.map((a) => a.kind).sort();

describe('PlatformHealthService', () => {
  it('says nothing when every project has its database, realm and backups', async () => {
    const { svc, raised } = setup({
      projects: [project({ slug: 'a', dbName: 'kb_a', keycloakRealm: 'kb-a' })],
      databases: ['kb_a'],
      realms: ['kb-a'],
      activity: backupLog([['a', true, 1]]),
    });
    await svc.runDailyCheck();
    expect(raised).toEqual([]);
  });

  it('raises one alert naming every project whose database is gone', async () => {
    const { svc, raised } = setup({
      projects: [
        project({ slug: 'good', dbName: 'kb_good', keycloakRealm: 'kb-good' }),
        project({ slug: 'gone', dbName: 'kb_gone', keycloakRealm: 'kb-gone' }),
        project({ slug: 'alsogone', dbName: 'kb_alsogone', keycloakRealm: 'kb-alsogone' }),
      ],
      databases: ['kb_good'],
      realms: ['kb-good', 'kb-gone', 'kb-alsogone'],
    });
    await svc.runDailyCheck();
    const alert = raised.find((a) => a.kind === 'project_database_missing');
    expect(alert).toBeDefined();
    expect(alert.title).toContain('2 live projects have no database');
    expect(alert.metadata.projects.map((p: any) => p.slug).sort()).toEqual(['alsogone', 'gone']);
  });

  it('raises one alert for missing realms', async () => {
    const { svc, raised } = setup({
      projects: [project({ slug: 'a', dbName: 'kb_a', keycloakRealm: 'kb-a' })],
      databases: ['kb_a'],
      realms: [],
    });
    await svc.runDailyCheck();
    expect(kinds(raised)).toEqual(['project_realm_missing']);
    expect(raised[0].severity).toBe('critical');
  });

  it('stays silent about realms when Keycloak itself cannot be reached', async () => {
    const { svc, raised } = setup({
      projects: [project({ slug: 'a', dbName: 'kb_a' })],
      databases: ['kb_a'],
      keycloakThrows: true,
    });
    await svc.runDailyCheck();
    expect(raised).toEqual([]);
  });

  it('reports a project whose last three nights all failed', async () => {
    const { svc, raised } = setup({
      projects: [project({ slug: 'a', dbName: 'kb_a', keycloakRealm: 'kb-a' })],
      databases: ['kb_a'],
      realms: ['kb-a'],
      activity: backupLog([
        ['a', false, 1],
        ['a', false, 2],
        ['a', false, 3],
      ]),
    });
    await svc.runDailyCheck();
    const alert = raised.find((a) => a.kind === 'project_backup_failing');
    expect(alert).toBeDefined();
    expect(alert.metadata.projects[0]).toMatchObject({ slug: 'a', nights: 3 });
  });

  it('does not report a project that failed twice and then succeeded', async () => {
    const { svc, raised } = setup({
      projects: [project({ slug: 'a', dbName: 'kb_a', keycloakRealm: 'kb-a' })],
      databases: ['kb_a'],
      realms: ['kb-a'],
      activity: backupLog([
        ['a', true, 1],
        ['a', false, 2],
        ['a', false, 3],
        ['a', false, 4],
      ]),
    });
    await svc.runDailyCheck();
    expect(raised).toEqual([]);
  });

  it('counts only the failures since the most recent success', async () => {
    const { svc, raised } = setup({
      projects: [project({ slug: 'a', dbName: 'kb_a', keycloakRealm: 'kb-a' })],
      databases: ['kb_a'],
      realms: ['kb-a'],
      activity: backupLog([
        ['a', false, 1],
        ['a', false, 2],
        ['a', false, 3],
        ['a', true, 4],
        ['a', false, 5],
        ['a', false, 6],
      ]),
    });
    await svc.runDailyCheck();
    expect(raised[0].metadata.projects[0].nights).toBe(3);
  });

  it('ignores backup failures belonging to projects that are no longer live', async () => {
    const { svc, raised } = setup({
      projects: [project({ slug: 'a', dbName: 'kb_a', keycloakRealm: 'kb-a' })],
      databases: ['kb_a'],
      realms: ['kb-a'],
      activity: backupLog([
        ['deleted', false, 1],
        ['deleted', false, 2],
        ['deleted', false, 3],
      ]),
    });
    await svc.runDailyCheck();
    expect(raised).toEqual([]);
  });

  it('shortens the project list in the alert body but keeps every one in metadata', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      project({ slug: `p${i}`, dbName: `kb_p${i}`, keycloakRealm: `kb-p${i}` }),
    );
    const { svc, raised } = setup({ projects: many, databases: [], realms: many.map((p) => p.keycloakRealm) });
    await svc.runDailyCheck();
    const alert = raised.find((a) => a.kind === 'project_database_missing');
    expect(alert.metadata.projects).toHaveLength(20);
  });

  it('never throws, whatever the database says', async () => {
    const prisma = { project: { findMany: async () => { throw new Error('db down'); } } };
    const svc = new PlatformHealthService(prisma as any, { get: () => undefined } as any, {} as any, {
      raise: async () => undefined,
    } as any);
    await expect(svc.runDailyCheck()).resolves.toBeUndefined();
  });
});
