// The import service reaches an ESM-only Keycloak client through two of its
// imports, which Jest cannot load. Only their identity matters here.
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('pg', () => ({ Pool: jest.fn() }));

import { Pool } from 'pg';
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
