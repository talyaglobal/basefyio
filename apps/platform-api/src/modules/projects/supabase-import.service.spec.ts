// The import service reaches an ESM-only Keycloak client through two of its
// imports, which Jest cannot load. Only their identity matters here.
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('pg', () => ({ Pool: jest.fn() }));
// The schema dump drives Docker and the scratch volume; both are stand-ins here.
const mockDocker = {
  pull: jest.fn(),
  modem: { followProgress: jest.fn() },
  createContainer: jest.fn(),
};
jest.mock('dockerode', () => jest.fn(() => mockDocker));
jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
  readFile: jest.fn(),
  unlink: jest.fn(async () => undefined),
}));

import { Pool } from 'pg';
import { readFile } from 'fs/promises';
import { of } from 'rxjs';
import {
  SupabaseImportService,
  type ImportProgress,
  type TableReconciliation,
} from './supabase-import.service';
import { SupabaseImportKeysService } from './supabase-import-keys.service';

/** A service with no live dependencies: the parts under test are self-contained. */
function service() {
  const svc: any = Object.create(SupabaseImportService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.keys = new SupabaseImportKeysService();
  svc.cancelledJobs = new Set<string>();
  return svc;
}

function progressOf(): ImportProgress {
  return {
    database: { tables: 0, rows: 0, failedTables: [] },
    auth: { users: 0, skipped: 0 },
    storage: { buckets: 0, objects: 0 },
    warnings: [],
  };
}

const pk = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  description: 'Note:\nThis is a Primary Key.<pk/>',
  ...extra,
});

describe('SupabaseImportService.extractColumnsFromOpenApi', () => {
  it('marks the key columns the description names and nothing else', () => {
    const svc = service();
    const columns = svc.extractColumnsFromOpenApi(
      {
        definitions: {
          items: {
            required: ['id'],
            properties: {
              id: pk('string', { format: 'uuid' }),
              name: { type: 'string' },
            },
          },
        },
      },
      'items',
    );
    expect(columns).toEqual([
      expect.objectContaining({ column_name: 'id', data_type: 'uuid', is_primary_key: true }),
      expect.objectContaining({ column_name: 'name', data_type: 'text', is_primary_key: false }),
    ]);
  });
});

describe('SupabaseImportService.createLocalTable', () => {
  function poolWith(behaviour?: (sql: string) => void) {
    const client = {
      query: jest.fn(async (sql: string) => {
        behaviour?.(sql);
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => client) };
    const ran = () => client.query.mock.calls.map(([sql]: [string]) => sql);
    return { pool, client, ran };
  }

  const col = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
    column_name: name,
    data_type: type,
    is_nullable: 'YES',
    column_default: null,
    character_maximum_length: null,
    udt_name: type,
    ...extra,
  });

  it('emits the primary key as a table constraint', async () => {
    const svc = service();
    const { pool, ran } = poolWith();
    const result = await svc.createLocalTable(pool, 'items', [
      col('id', 'uuid', { is_primary_key: true }),
      col('name', 'text'),
    ]);
    expect(result).toEqual({ withPrimaryKey: true, primaryKeyColumns: ['id'], error: undefined });
    expect(ran()).toEqual([
      'DROP TABLE IF EXISTS "items" CASCADE',
      'CREATE TABLE "items" (\n  "id" uuid,\n  "name" text,\n  PRIMARY KEY ("id")\n)',
    ]);
  });

  it('keeps a composite key in column order', async () => {
    const svc = service();
    const { pool, ran } = poolWith();
    await svc.createLocalTable(pool, 'memberships', [
      col('tenant_id', 'uuid', { is_primary_key: true }),
      col('user_id', 'uuid', { is_primary_key: true }),
      col('role', 'text'),
    ]);
    expect(ran()[1]).toContain('PRIMARY KEY ("tenant_id", "user_id")');
  });

  it('builds a table with no key exactly as before', async () => {
    const svc = service();
    const { pool, ran } = poolWith();
    const result = await svc.createLocalTable(pool, 'log_lines', [col('id', 'uuid'), col('message', 'text')]);
    expect(result.withPrimaryKey).toBe(false);
    expect(ran()[1]).toBe('CREATE TABLE "log_lines" (\n  "id" uuid,\n  "message" text\n)');
  });

  it('creates the sequence a serial default names, then hands it to the column', async () => {
    const svc = service();
    const { pool, ran } = poolWith();
    await svc.createLocalTable(pool, 'items', [
      col('id', 'bigint', { is_primary_key: true, column_default: "nextval('items_id_seq'::regclass)" }),
    ]);
    expect(ran()).toEqual([
      'DROP TABLE IF EXISTS "items" CASCADE',
      'CREATE SEQUENCE IF NOT EXISTS "public"."items_id_seq"',
      'CREATE TABLE "items" (\n  "id" bigint DEFAULT nextval(\'"public"."items_id_seq"\'::regclass),\n  PRIMARY KEY ("id")\n)',
      'ALTER SEQUENCE "public"."items_id_seq" OWNED BY "items"."id"',
    ]);
  });

  it('drops a serial default it cannot name safely instead of failing the table', async () => {
    const svc = service();
    const { pool, ran } = poolWith();
    await svc.createLocalTable(pool, 'items', [
      col('id', 'bigint', { column_default: "nextval('x; drop table y'::regclass)" }),
    ]);
    expect(ran().some((sql) => /CREATE SEQUENCE/.test(sql))).toBe(false);
    expect(ran()[1]).toBe('CREATE TABLE "items" (\n  "id" bigint\n)');
  });

  it('keeps the other safe defaults', async () => {
    const svc = service();
    const { pool, ran } = poolWith();
    await svc.createLocalTable(pool, 'items', [
      col('id', 'uuid', { column_default: 'gen_random_uuid()' }),
      col('created_at', 'timestamptz', { column_default: 'now()' }),
    ]);
    expect(ran()[1]).toBe(
      'CREATE TABLE "items" (\n  "id" uuid DEFAULT gen_random_uuid(),\n  "created_at" timestamptz DEFAULT now()\n)',
    );
  });

  it('falls back to a keyless table when the keyed statement is refused, and says so', async () => {
    const svc = service();
    const { pool, ran } = poolWith((sql) => {
      if (/PRIMARY KEY/.test(sql)) throw new Error('could not create unique index');
    });
    const result = await svc.createLocalTable(pool, 'items', [col('id', 'uuid', { is_primary_key: true })]);
    expect(result).toEqual({
      withPrimaryKey: false,
      primaryKeyColumns: ['id'],
      error: 'could not create unique index',
    });
    expect(ran()[2]).toBe('CREATE TABLE "items" (\n  "id" uuid\n)');
  });

  it('still fails outright when a keyless table cannot be created', async () => {
    const svc = service();
    const { pool } = poolWith((sql) => {
      if (/CREATE TABLE/.test(sql)) throw new Error('type does not exist');
    });
    await expect(svc.createLocalTable(pool, 'items', [col('id', 'weird')])).rejects.toThrow(
      'type does not exist',
    );
  });
});

describe('SupabaseImportService.countSourceRows', () => {
  const restReturning = (answers: Array<{ count?: number | null; error?: { message: string } | null }>) => {
    const select = jest.fn();
    for (const a of answers) select.mockResolvedValueOnce({ count: a.count ?? null, error: a.error ?? null });
    return { client: { from: jest.fn(() => ({ select })) }, select };
  };

  it('counts over the direct connection when there is one', async () => {
    const svc = service();
    const sourcePool = { query: jest.fn(async (_sql: string) => ({ rows: [{ n: '42' }] })) };
    const result = await svc.countSourceRows(sourcePool, null, 'items');
    expect(result).toEqual({ rows: 42, method: 'direct' });
    expect(sourcePool.query.mock.calls[0][0]).toBe('select count(*) as n from "public"."items"');
  });

  it('asks the API for an exact count with a HEAD request otherwise', async () => {
    const svc = service();
    const { client, select } = restReturning([{ count: 7 }]);
    const result = await svc.countSourceRows(null, client, 'items');
    expect(result).toEqual({ rows: 7, method: 'rest' });
    expect(select).toHaveBeenCalledWith('*', { count: 'exact', head: true });
  });

  it("takes the planner's estimate, labelled, when the exact count fails", async () => {
    const svc = service();
    const { client, select } = restReturning([
      { error: { message: 'canceling statement due to statement timeout' } },
      { count: 120000 },
    ]);
    const result = await svc.countSourceRows(null, client, 'items');
    expect(result).toEqual({ rows: 120000, method: 'rest-planned' });
    expect(select).toHaveBeenLastCalledWith('*', { count: 'planned', head: true });
  });

  it('reports the source as uncountable rather than failing', async () => {
    const svc = service();
    const { client } = restReturning([{ error: { message: 'nope' } }, { error: { message: 'nope' } }]);
    await expect(svc.countSourceRows(null, client, 'items')).resolves.toEqual({
      rows: null,
      method: 'unavailable',
    });
    await expect(svc.countSourceRows(null, null, 'items')).resolves.toEqual({
      rows: null,
      method: 'unavailable',
    });
  });

  it('falls through to the API when the direct count fails', async () => {
    const svc = service();
    const sourcePool = { query: jest.fn(async () => { throw new Error('permission denied'); }) };
    const { client } = restReturning([{ count: 3 }]);
    await expect(svc.countSourceRows(sourcePool, client, 'items')).resolves.toEqual({
      rows: 3,
      method: 'rest',
    });
  });

  it('gives up on a count that never answers once the ceiling passes', async () => {
    jest.useFakeTimers();
    try {
      const svc = service();
      const sourcePool = { query: jest.fn(() => new Promise(() => undefined)) };
      const pending = svc.countSourceRows(sourcePool, null, 'items');
      await jest.advanceTimersByTimeAsync(15_001);
      await expect(pending).resolves.toEqual({ rows: null, method: 'unavailable' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SupabaseImportService.reconcileTables', () => {
  const entry = (patch: Partial<TableReconciliation>): TableReconciliation => ({
    table: 't',
    sourceRows: null,
    importedRows: 0,
    destinationRows: null,
    rowCountMismatch: false,
    sourceCountMethod: 'unavailable',
    primaryKey: 'unknown',
    ...patch,
  });

  it('fills destination counts and flags the tables that differ', () => {
    const svc = service();
    const progress = progressOf();
    progress.tables = [
      entry({ table: 'items', sourceRows: 1200, importedRows: 1150, sourceCountMethod: 'direct' }),
      entry({ table: 'users', sourceRows: 10, importedRows: 10, sourceCountMethod: 'direct' }),
    ];
    svc.reconcileTables(progress, new Map([['items', 1150], ['users', 10]]), new Set(['items', 'users']));
    expect(progress.tables[0]).toMatchObject({ destinationRows: 1150, rowCountMismatch: true, primaryKey: 'present' });
    expect(progress.tables[1]).toMatchObject({ destinationRows: 10, rowCountMismatch: false });
    expect(progress.warnings).toEqual([
      'Reconciliation: "items" has 1200 row(s) at the source and 1150 here (50 missing).',
    ]);
  });

  it('calls more rows here than at the source "extra"', () => {
    const svc = service();
    const progress = progressOf();
    progress.tables = [entry({ table: 'items', sourceRows: 5, sourceCountMethod: 'rest' })];
    svc.reconcileTables(progress, new Map([['items', 8]]), new Set(['items']));
    expect(progress.warnings[0]).toMatch(/\(3 extra\)/);
  });

  it('never flags a table whose source could not be counted or was only estimated', () => {
    const svc = service();
    const progress = progressOf();
    progress.tables = [
      entry({ table: 'a', sourceRows: null }),
      entry({ table: 'b', sourceRows: 999, sourceCountMethod: 'rest-planned' }),
    ];
    svc.reconcileTables(progress, new Map([['a', 4], ['b', 1000]]), new Set(['a', 'b']));
    expect(progress.tables.map((t) => t.rowCountMismatch)).toEqual([false, false]);
    expect(progress.warnings).toEqual([]);
  });

  it('adds a line for a destination table the run never touched', () => {
    const svc = service();
    const progress = progressOf();
    progress.tables = [];
    svc.reconcileTables(progress, new Map([['orphan', 3]]), new Set());
    expect(progress.tables).toEqual([
      expect.objectContaining({ table: 'orphan', destinationRows: 3, importedRows: 0, primaryKey: 'missing' }),
    ]);
  });

  it('settles the key state from the catalogue but keeps a repaired key as "added"', () => {
    const svc = service();
    const progress = progressOf();
    progress.tables = [
      entry({ table: 'fixed', primaryKey: 'added' }),
      entry({ table: 'keyed' }),
      entry({ table: 'bare' }),
    ];
    svc.reconcileTables(progress, new Map([['fixed', 1], ['keyed', 1], ['bare', 1]]), new Set(['keyed', 'fixed']));
    expect(progress.tables.map((t) => t.primaryKey)).toEqual(['added', 'present', 'missing']);
    expect(progress.warnings).toEqual([
      expect.stringMatching(/1 table\(s\) have no primary key.*: bare\. Use "Add missing primary keys" to repair\./),
    ]);
  });

  it('leaves the key state unknown when the catalogue could not be read', () => {
    const svc = service();
    const progress = progressOf();
    progress.tables = [entry({ table: 'a' })];
    svc.reconcileTables(progress, new Map([['a', 1]]), null);
    expect(progress.tables[0].primaryKey).toBe('unknown');
    expect(progress.warnings).toEqual([]);
  });

  it('caps the mismatch lines at ten and counts the rest', () => {
    const svc = service();
    const progress = progressOf();
    progress.tables = Array.from({ length: 12 }, (_, i) =>
      entry({ table: `t${i}`, sourceRows: 10, sourceCountMethod: 'direct' }),
    );
    svc.reconcileTables(progress, new Map(progress.tables.map((t) => [t.table, 9])), new Set(progress.tables.map((t) => t.table)));
    expect(progress.warnings).toHaveLength(11);
    expect(progress.warnings[10]).toBe('Reconciliation: 2 more table(s) differ from the source.');
  });
});

describe('SupabaseImportService.runSyncImport', () => {
  const project = {
    supabaseDatabasePassword: 'pw',
    dbHost: 'h',
    dbPort: 5432,
    dbUser: 'u',
    dbPassword: 'p',
    dbName: 'db',
  };
  const headers = { apikey: 'k', Authorization: 'Bearer k' };

  function syncing(opts: { tables: string[]; perTable: Record<string, { copied: number; sourceRows: number; destinationRows: number }> }) {
    const svc = service();
    const destination = { query: jest.fn(), end: jest.fn(async () => undefined), connect: jest.fn() };
    (Pool as unknown as jest.Mock).mockImplementation(() => destination);
    const sourcePool = { query: jest.fn(), end: jest.fn(async () => undefined) };

    svc.resolveSupabaseProjectRef = jest.fn(() => 'ref');
    svc.openSupabaseSourcePool = jest.fn(async () => sourcePool);
    svc.connectPoolWithRetry = jest.fn(async () => undefined);
    svc.tablesInDependencyOrder = jest.fn(async () => opts.tables);
    svc.syncTable = jest.fn(async (_s: unknown, _d: unknown, name: string) => opts.perTable[name]);
    svc.keys.keysFromSourceCatalog = jest.fn(async () => new Map([['bare', ['id']]]));
    svc.keys.repairPrimaryKeys = jest.fn(async () => ({
      dryRun: false, examined: 1, added: 1, wouldAdd: 0, skipped: 0, failed: 0, pending: 0,
      results: [{ table: 'bare', columns: ['id'], status: 'added' }],
    }));
    return { svc, destination, sourcePool };
  }

  it('records what each table held on both sides and never repairs keys unasked', async () => {
    const { svc } = syncing({
      tables: ['users', 'items'],
      perTable: {
        users: { copied: 0, sourceRows: 10, destinationRows: 10 },
        items: { copied: 5, sourceRows: 15, destinationRows: 10 },
      },
    });
    const progress = progressOf();
    await svc.runSyncImport('https://x.supabase.co', headers, project, progress, 'job');

    expect(svc.keys.repairPrimaryKeys).not.toHaveBeenCalled();
    expect(progress.database.rows).toBe(5);
    expect(progress.tables).toEqual([
      expect.objectContaining({ table: 'users', sourceRows: 10, importedRows: 0, destinationRows: 10, sourceCountMethod: 'direct' }),
      expect.objectContaining({ table: 'items', sourceRows: 15, importedRows: 5, destinationRows: 15, sourceCountMethod: 'direct' }),
    ]);
  });

  it('repairs keys first when asked, and marks the repaired table', async () => {
    const { svc, destination } = syncing({
      tables: ['bare'],
      perTable: { bare: { copied: 2, sourceRows: 4, destinationRows: 2 } },
    });
    const progress = progressOf();
    const order: string[] = [];
    svc.keys.repairPrimaryKeys.mockImplementation(async () => {
      order.push('repair');
      return {
        dryRun: false, examined: 1, added: 1, wouldAdd: 0, skipped: 0, failed: 0, pending: 0,
        results: [{ table: 'bare', columns: ['id'], status: 'added' }],
      };
    });
    svc.syncTable.mockImplementation(async () => {
      order.push('sync');
      return { copied: 2, sourceRows: 4, destinationRows: 2 };
    });

    await svc.runSyncImport('https://x.supabase.co', headers, project, progress, 'job', undefined, {
      repairKeys: true,
    });

    expect(order).toEqual(['repair', 'sync']);
    expect(svc.keys.repairPrimaryKeys).toHaveBeenCalledWith(destination, expect.any(Map), { budgetMs: 600_000 });
    expect(progress.tables?.[0]).toMatchObject({ table: 'bare', primaryKey: 'added', importedRows: 2 });
  });

  it('turns a refused repair into a warning and still compares the rest', async () => {
    const { svc } = syncing({
      tables: ['bare'],
      perTable: { bare: { copied: 0, sourceRows: 1, destinationRows: 1 } },
    });
    svc.keys.repairPrimaryKeys.mockResolvedValue({
      dryRun: false, examined: 1, added: 0, wouldAdd: 0, skipped: 1, failed: 0, pending: 0,
      results: [{ table: 'bare', columns: ['id'], status: 'not_unique', duplicateGroups: 2, nullRows: 0 }],
    });
    const progress = progressOf();
    await svc.runSyncImport('https://x.supabase.co', headers, project, progress, 'job', undefined, {
      repairKeys: true,
    });
    expect(progress.warnings).toEqual([
      expect.stringMatching(/Table "bare": primary key not added — rows are not unique on \(id\): 2 duplicate value group\(s\)\./),
    ]);
    expect(svc.syncTable).toHaveBeenCalledTimes(1);
  });

  it('keeps a line, with the reason, for a table that could not be compared', async () => {
    const { svc } = syncing({ tables: ['odd'], perTable: {} });
    svc.syncTable.mockRejectedValue(new Error('no primary key, so new rows cannot be told from existing ones'));
    const progress = progressOf();
    await svc.runSyncImport('https://x.supabase.co', headers, project, progress, 'job');
    expect(progress.tables).toEqual([
      expect.objectContaining({ table: 'odd', importedRows: 0, note: expect.stringMatching(/no primary key/) }),
    ]);
    expect(progress.warnings[0]).toMatch(/could not be synced/);
  });
});

describe('SupabaseImportService.openSupabaseSourceRoute', () => {
  const REF = 'abcdefghijklmnopqrst';
  const PASSWORD = 'hunter2-secret';
  const CANDIDATES = (SupabaseImportService as any).SUPABASE_POOLER_REGIONS.length * 2;

  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  /** Every pooler candidate answers with what `errFor` says; the direct endpoint fails as `direct` says. */
  function routeService(direct: Error | null, errFor: (host: string) => Error | null) {
    const svc = service();
    svc.sourceConnByRef = new Map();
    svc.connectPoolWithRetry = jest.fn(async () => {
      if (direct) throw direct;
    });
    (Pool as unknown as jest.Mock).mockImplementation((opts: any) => ({
      connect: jest.fn(async () => {
        const err = errFor(opts.host);
        if (err) throw err;
        return { release: jest.fn() };
      }),
      end: jest.fn(async () => undefined),
    }));
    return svc;
  }

  afterEach(() => (Pool as unknown as jest.Mock).mockReset());

  it('names the one region that rejected the password over the many that never heard of the tenant', async () => {
    const svc = routeService(
      Object.assign(new Error('connect ENETUNREACH 2a05:d012::1:5432'), { code: 'ENETUNREACH' }),
      (host) =>
        host.includes('eu-central-1')
          ? pgError('28P01', `password authentication failed for user "postgres.${REF}"`)
          : pgError('XX000', 'Tenant or user not found'),
    );
    const route = await svc.openSupabaseSourceRoute(REF, PASSWORD);

    expect(route.pool).toBeNull();
    expect(route.failure).toEqual({
      summary: `direct: ENETUNREACH connect ENETUNREACH 2a05:d012::1:5432; pooler: 28P01 password authentication failed, 2 of ${CANDIDATES} candidates`,
      passwordRejected: true,
    });
    const line = SupabaseImportService.unreachableSourceWarning(route.failure);
    expect(line).toBe(
      `Could not reach the source database directly (direct: ENETUNREACH connect ENETUNREACH 2a05:d012::1:5432; pooler: 28P01 password authentication failed, 2 of ${CANDIDATES} candidates). Tables protected by RLS may have imported empty; passwords were not carried. The database password was rejected — check Supabase → Settings → Database.`,
    );
    expect(line).not.toContain(PASSWORD);
  });

  it('reports the commonest pooler failure when nothing points at the password', async () => {
    const svc = routeService(
      new Error(`Connection to "supabase-direct-${REF}" timed out after 20s`),
      () => pgError('ETIMEDOUT', `connect ETIMEDOUT with password ${PASSWORD}`),
    );
    const route = await svc.openSupabaseSourceRoute(REF, PASSWORD);

    expect(route.pool).toBeNull();
    expect(route.failure?.passwordRejected).toBe(false);
    expect(route.failure?.summary).toBe(
      `direct: Connection to "supabase-direct-${REF}" timed out after 20s; pooler: ETIMEDOUT connect ETIMEDOUT with password ***, ${CANDIDATES} of ${CANDIDATES} candidates`,
    );
    expect(SupabaseImportService.unreachableSourceWarning(route.failure)).not.toMatch(/password was rejected/);
  });

  it('a pooler region that accepts the credentials is the route, and is remembered', async () => {
    const svc = routeService(
      Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }),
      (host) => (host === 'aws-0-eu-central-1.pooler.supabase.com' ? null : pgError('XX000', 'Tenant or user not found')),
    );
    const route = await svc.openSupabaseSourceRoute(REF, PASSWORD);

    expect(route.failure).toBeNull();
    expect(route.pool).not.toBeNull();
    expect(svc.sourceConnByRef.get(REF)).toEqual({
      host: 'aws-0-eu-central-1.pooler.supabase.com',
      user: `postgres.${REF}`,
    });
  });

  it('describes an error by its code first, and never with the password', () => {
    const describe = (err: unknown) => SupabaseImportService.describeConnectionError(err, PASSWORD);
    expect(describe(pgError('28P01', 'password authentication failed'))).toBe('28P01 password authentication failed');
    expect(describe(pgError('XX000', 'Tenant or user not found'))).toBe('tenant or user not found');
    expect(describe(pgError('ENOTFOUND', `getaddrinfo ENOTFOUND db.${REF}.supabase.co`))).toBe(
      `ENOTFOUND getaddrinfo ENOTFOUND db.${REF}.supabase.co`,
    );
    expect(describe(new Error(`bad ${PASSWORD} here`))).toBe('bad *** here');
    expect(describe(new Error('x'.repeat(200)))).toHaveLength(120);
  });
});

describe('SupabaseImportService.dumpSourceSchema', () => {
  const REF = 'abcdefghijklmnopqrst';
  const PASSWORD = 'hunter2-secret';

  function dumpService(o: { route?: boolean } = {}) {
    const svc = service();
    svc.sourceConnByRef = new Map(
      o.route === false ? [] : [[REF, { host: `db.${REF}.supabase.co`, user: 'postgres' }]],
    );
    return svc;
  }

  /** `docker.pull` succeeds and the container ends with `exit`, having logged `logs`. */
  function containerThat(exit: number, logs = '') {
    mockDocker.pull.mockImplementation((_image: string, cb: any) => cb(null, {}));
    mockDocker.modem.followProgress.mockImplementation((_s: any, cb: any) => cb(null));
    const container = {
      start: jest.fn(async () => undefined),
      wait: jest.fn(async () => ({ StatusCode: exit })),
      logs: jest.fn(async () => Buffer.from(logs)),
      remove: jest.fn(async () => undefined),
    };
    mockDocker.createContainer.mockResolvedValue(container);
    return container;
  }

  beforeEach(() => {
    mockDocker.pull.mockReset();
    mockDocker.modem.followProgress.mockReset();
    mockDocker.createContainer.mockReset();
    (readFile as jest.Mock).mockReset();
  });

  it('returns the schema when pg_dump succeeds', async () => {
    containerThat(0);
    (readFile as jest.Mock).mockResolvedValue('CREATE TABLE public.items ();');
    await expect(dumpService().dumpSourceSchema(REF, PASSWORD, 17)).resolves.toEqual({
      sql: 'CREATE TABLE public.items ();',
    });
  });

  it('says the image could not be pulled, and from where', async () => {
    mockDocker.pull.mockImplementation((_image: string, cb: any) =>
      cb(Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' })),
    );
    await expect(dumpService().dumpSourceSchema(REF, PASSWORD, 17)).resolves.toEqual({
      sql: null,
      reason: 'pulling postgres:17-alpine failed: connect ENOENT /var/run/docker.sock',
    });
  });

  it('carries the exit code and the last lines of pg_dump, trimmed and without the password', async () => {
    const container = containerThat(
      1,
      `pg_dump: error: connection to server at "db.${REF}.supabase.co" failed: password "${PASSWORD}" rejected\n` +
        'x'.repeat(400),
    );
    const result = await dumpService().dumpSourceSchema(REF, PASSWORD, 17);

    expect(result.sql).toBeNull();
    expect(result.reason).toMatch(/^pg_dump exited 1: pg_dump: error: connection to server at .* password "\*\*\*" rejected x+$/);
    expect(result.reason!.length).toBeLessThanOrEqual('pg_dump exited 1: '.length + 300);
    expect(result.reason).not.toContain(PASSWORD);
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it('says when the dump file could not be read back from the scratch volume', async () => {
    containerThat(0);
    (readFile as jest.Mock).mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied, open '/pitr-scratch/schema-x.sql'"), { code: 'EACCES' }),
    );
    const result = await dumpService().dumpSourceSchema(REF, PASSWORD, 17);
    expect(result.sql).toBeNull();
    expect(result.reason).toMatch(
      /^reading schema-[0-9a-f]{8}\.sql from the scratch volume failed: EACCES: permission denied/,
    );
  });

  it('says when no route to the source was ever recorded', async () => {
    containerThat(0);
    await expect(dumpService({ route: false }).dumpSourceSchema(REF, PASSWORD, 17)).resolves.toEqual({
      sql: null,
      reason: 'no direct route to the source was recorded',
    });
    expect(mockDocker.createContainer).not.toHaveBeenCalled();
  });

  it('the panel line names the reason and stays under 500 characters', () => {
    const short = SupabaseImportService.schemaNotCopiedWarning('pg_dump exited 1: no pg_hba.conf entry');
    expect(short).toBe(
      'The source schema could not be copied (pg_dump exited 1: no pg_hba.conf entry), so tables were rebuilt from column types alone — without indexes, keys, defaults, triggers or row-level security.',
    );
    const long = SupabaseImportService.schemaNotCopiedWarning('y'.repeat(900));
    expect(long.length).toBeLessThanOrEqual(500);
    expect(long).toMatch(/y+…\), so tables were rebuilt/);
  });
});

describe('SupabaseImportService.applySourceSchema', () => {
  it('hands back the first failures so a schema that applied nothing can say why', async () => {
    const svc = service();
    svc.prepareDestinationForSchema = jest.fn(async () => undefined);
    const client = {
      query: jest.fn(async (sql: string) => {
        throw new Error(`type "vector" does not exist in ${sql.slice(0, 12)}`);
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => client) };
    const progress = progressOf();

    const result = await svc.applySourceSchema(
      pool,
      'CREATE TABLE a (v vector);\nCREATE TABLE b (v vector);\n',
      progress,
    );

    expect(result).toMatchObject({ applied: 0, failed: 2, deferred: [] });
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatch(/^CREATE TABLE a \(v vector\);… — type "vector" does not exist/);
    expect(progress.warnings[0]).toMatch(/^2 schema statement\(s\) could not be applied\. First few: /);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('SupabaseImportService.importAuth', () => {
  const HASH = '$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW';
  const PROJECT = { id: 'p1', keycloakRealm: 'realm-p1' };
  const sourceUser = (id: string, email: string | null, extra: Record<string, unknown> = {}) => ({
    id,
    email,
    phone: '',
    role: 'authenticated',
    created_at: '2025-01-02T03:04:05Z',
    email_confirmed_at: '2025-01-02T03:05:00Z',
    user_metadata: {},
    ...extra,
  });

  function authService(
    users: unknown[],
    o: {
      hashes?: Map<string, string> | null;
      importRealmUsers?: (realm: string, batch: any[]) => Promise<unknown>;
    } = {},
  ) {
    const svc = service();
    svc.http = { get: jest.fn(() => of({ data: { users } })) };
    svc.keycloak = {
      importRealmUsers: jest.fn(
        o.importRealmUsers ??
          (async (_realm: string, batch: any[]) =>
            batch.map((u) => ({ action: 'ADDED', username: u.username, id: u.id }))),
      ),
    };
    svc.importedPasswords = { stash: jest.fn(async (_p: string, entries: unknown[]) => entries.length) };
    svc.readSourcePasswordHashes = jest.fn().mockResolvedValue(o.hashes === undefined ? null : o.hashes);
    return svc;
  }

  const run = (svc: any, progress: ImportProgress) =>
    svc.importAuth('https://x.supabase.co', {}, PROJECT, progress, 'Shop');

  it('creates users with their source ids and carries their passwords over', async () => {
    const svc = authService(
      [
        sourceUser('11111111-1111-1111-1111-111111111111', 'Ada@Example.com', {
          user_metadata: { full_name: 'Ada Lovelace' },
        }),
        sourceUser('22222222-2222-2222-2222-222222222222', 'bob@example.com', { email_confirmed_at: null }),
        sourceUser('33333333-3333-3333-3333-333333333333', null),
        sourceUser('44444444-4444-4444-4444-444444444444', 'gone@example.com', { deleted_at: '2025-02-01T00:00:00Z' }),
        sourceUser('55555555-5555-5555-5555-555555555555', 'banned@example.com', { banned_until: '2999-01-01T00:00:00Z' }),
      ],
      { hashes: new Map([['11111111-1111-1111-1111-111111111111', HASH], ['22222222-2222-2222-2222-222222222222', '$argon2id$x']]) },
    );
    const progress = progressOf();
    await run(svc, progress);

    const [realm, batch] = svc.keycloak.importRealmUsers.mock.calls[0];
    expect(realm).toBe('realm-p1');
    expect(batch).toEqual([
      expect.objectContaining({
        id: '11111111-1111-1111-1111-111111111111',
        username: 'ada@example.com',
        email: 'Ada@Example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        enabled: true,
        emailVerified: true,
        createdTimestamp: Date.parse('2025-01-02T03:04:05Z'),
      }),
      expect.objectContaining({ id: '22222222-2222-2222-2222-222222222222', emailVerified: false, firstName: 'bob', lastName: 'bob' }),
      expect.objectContaining({ id: '55555555-5555-5555-5555-555555555555', enabled: false }),
    ]);
    expect(progress.auth).toEqual({ users: 3, skipped: 2, passwords: 1 });
    expect(svc.importedPasswords.stash).toHaveBeenCalledWith('p1', [
      { userId: '11111111-1111-1111-1111-111111111111', email: 'Ada@Example.com', hash: HASH },
    ]);
    expect(progress.warnings.join('\n')).toMatch(/1 user\(s\) have a password in a format that cannot be verified/);
    expect(progress.warnings.join('\n')).toMatch(/banned at the source were imported disabled/);
    expect(progress.warnings.join('\n')).not.toMatch(/passwords were not carried over/);
  });

  it('without the database password, users still arrive with their ids and the warning says why passwords did not', async () => {
    const svc = authService([sourceUser('11111111-1111-1111-1111-111111111111', 'ada@example.com')]);
    const progress = progressOf();
    await run(svc, progress);
    expect(progress.auth.users).toBe(1);
    expect(svc.importedPasswords.stash).not.toHaveBeenCalled();
    expect(progress.warnings.join('\n')).toMatch(/needs the source database password/);
  });

  it('an address already taken by a different account is reported, and its password is not attached to it', async () => {
    const svc = authService([sourceUser('11111111-1111-1111-1111-111111111111', 'ada@example.com')], {
      hashes: new Map([['11111111-1111-1111-1111-111111111111', HASH]]),
      importRealmUsers: async (_r, batch) =>
        batch.map((u: any) => ({ action: 'SKIPPED', username: u.username, id: 'kc-generated-id' })),
    });
    const progress = progressOf();
    await run(svc, progress);
    expect(progress.auth).toMatchObject({ users: 0, skipped: 1 });
    expect(svc.importedPasswords.stash).not.toHaveBeenCalled();
    expect(progress.warnings.join('\n')).toMatch(/1 user\(s\) already existed in this project under a different id/);
  });

  it('a user re-imported under the same id (a sync) keeps getting their password', async () => {
    const svc = authService([sourceUser('11111111-1111-1111-1111-111111111111', 'ada@example.com')], {
      hashes: new Map([['11111111-1111-1111-1111-111111111111', HASH]]),
      importRealmUsers: async (_r, batch) =>
        batch.map((u: any) => ({ action: 'SKIPPED', username: u.username, id: u.id })),
    });
    const progress = progressOf();
    await run(svc, progress);
    expect(svc.importedPasswords.stash).toHaveBeenCalledTimes(1);
    expect(progress.warnings.join('\n')).not.toMatch(/different id/);
  });

  it('lists users in pages of 100, the ceiling GoTrue accepts, until a short page ends it', async () => {
    const all = Array.from({ length: 250 }, (_, i) =>
      sourceUser(`${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`, `u${i}@example.com`),
    );
    const svc = authService([]);
    svc.http.get = jest.fn((_url: string, o: any) => {
      const { page, per_page } = o.params;
      return of({ data: { users: all.slice((page - 1) * per_page, page * per_page) } });
    });
    const progress = progressOf();
    await run(svc, progress);

    expect(svc.http.get).toHaveBeenCalledTimes(3);
    for (const [, o] of svc.http.get.mock.calls) expect(o.params.per_page).toBe(100);
    expect(svc.http.get.mock.calls.map(([, o]: any[]) => o.params.page)).toEqual([1, 2, 3]);
    expect(progress.auth.users).toBe(250);
    expect(progress.warnings.join('\n')).not.toMatch(/page \d+ failed/);
  });

  it('a first page that fails is the whole import failing', async () => {
    const svc = authService([]);
    svc.http.get = jest.fn(() => {
      throw new Error('Request failed with status code 500');
    });
    await expect(run(svc, progressOf())).rejects.toThrow(
      'Failed to fetch Supabase auth users: Request failed with status code 500',
    );
  });

  it('a later page that fails keeps what came before and says what was lost', async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      sourceUser(`${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`, `u${i}@example.com`),
    );
    const svc = authService([]);
    svc.http.get = jest.fn((_url: string, o: any) => {
      if (o.params.page === 1) return of({ data: { users: first } });
      throw new Error('Request failed with status code 502');
    });
    const progress = progressOf();
    await run(svc, progress);

    expect(progress.auth.users).toBe(100);
    expect(progress.warnings).toContain(
      'Auth users page 2 failed (Request failed with status code 502), so only the 100 user(s) listed before it were imported. Run a sync to fetch the rest.',
    );
  });

  it('one bad user does not sink the rest of its batch', async () => {
    const svc = authService(
      [
        sourceUser('11111111-1111-1111-1111-111111111111', 'ada@example.com'),
        sourceUser('22222222-2222-2222-2222-222222222222', 'bad@example.com'),
      ],
      {
        importRealmUsers: async (_r, batch) => {
          if (batch.some((u: any) => u.username === 'bad@example.com')) throw new Error('duplicate key');
          return batch.map((u: any) => ({ action: 'ADDED', username: u.username, id: u.id }));
        },
      },
    );
    const progress = progressOf();
    await run(svc, progress);
    expect(svc.keycloak.importRealmUsers).toHaveBeenCalledTimes(3);
    expect(progress.auth).toMatchObject({ users: 1, skipped: 1 });
    expect(progress.warnings).toContain('Auth user "bad@example.com": duplicate key');
  });
});
