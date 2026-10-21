import { BadRequestException } from '@nestjs/common';
import { SupabaseImportKeysService } from './supabase-import-keys.service';

/**
 * A database that answers the catalogue and count queries the repair asks,
 * from a description of what it holds, and records every statement it ran.
 */
function fakeDb(state: {
  missing?: string[];
  columns?: Record<string, string[]>;
  duplicates?: Record<string, number>;
  nulls?: Record<string, number>;
  alterError?: { code?: string; message: string };
}) {
  const statements: string[] = [];
  const query = jest.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql.replace(/\s+/g, ' ').trim());
    if (/information_schema\.tables t/.test(sql)) {
      return { rows: (state.missing ?? []).map((name) => ({ name })) };
    }
    if (/information_schema\.columns/.test(sql)) {
      const table = String(values?.[0]);
      return { rows: (state.columns?.[table] ?? []).map((column_name) => ({ column_name })) };
    }
    if (/having count\(\*\) > 1/.test(sql)) {
      const table = /"public"\."([^"]+)"/.exec(sql)?.[1] ?? '';
      return { rows: [{ groups: state.duplicates?.[table] ?? 0 }] };
    }
    if (/ is null/.test(sql)) {
      const table = /"public"\."([^"]+)"/.exec(sql)?.[1] ?? '';
      return { rows: [{ nulls: state.nulls?.[table] ?? 0 }] };
    }
    if (/^ALTER TABLE/.test(sql)) {
      if (state.alterError) {
        const err: any = new Error(state.alterError.message);
        err.code = state.alterError.code;
        throw err;
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, statements };
}

describe('SupabaseImportKeysService.keysFromOpenApi', () => {
  const svc = new SupabaseImportKeysService();

  it('reads the key from the <pk/> tag in a column description', () => {
    const keys = svc.keysFromOpenApi({
      definitions: {
        items: {
          properties: {
            id: { type: 'integer', description: 'Note:\nThis is a Primary Key.<pk/>' },
            name: { type: 'string' },
          },
        },
      },
    });
    expect(keys.get('items')).toEqual(['id']);
  });

  it('keeps composite keys in property order', () => {
    const keys = svc.keysFromOpenApi({
      definitions: {
        memberships: {
          properties: {
            tenant_id: { type: 'string', format: 'uuid', description: 'Note:\nThis is a Primary Key.<pk/>' },
            user_id: { type: 'string', format: 'uuid', description: 'Note:\nThis is a Primary Key.<pk/>' },
            role: { type: 'string' },
          },
        },
      },
    });
    expect(keys.get('memberships')).toEqual(['tenant_id', 'user_id']);
  });

  it('accepts the written note when the tag is absent', () => {
    const keys = svc.keysFromOpenApi({
      definitions: { plans: { properties: { code: { type: 'string', description: 'This is a Primary Key.' } } } },
    });
    expect(keys.get('plans')).toEqual(['code']);
  });

  it('does not mistake a comment that mentions a key for the key itself', () => {
    expect(
      svc.isPrimaryKeyNote('References the primary key of users; set by the application.'),
    ).toBe(false);
  });

  it('ignores definitions without properties and tables without a key', () => {
    const keys = svc.keysFromOpenApi({
      definitions: {
        view_only: { type: 'object' },
        log_lines: { properties: { message: { type: 'string' } } },
      },
    });
    expect(keys.size).toBe(0);
  });

  it('returns an empty map for a spec with no definitions', () => {
    expect(svc.keysFromOpenApi({}).size).toBe(0);
    expect(svc.keysFromOpenApi(null).size).toBe(0);
  });
});

describe('SupabaseImportKeysService.keysFromSourceCatalog', () => {
  const svc = new SupabaseImportKeysService();

  it('maps each catalogue row to its ordered key columns', async () => {
    const source = {
      query: jest.fn(async (_sql: string) => ({
        rows: [
          { table: 'items', columns: ['id'] },
          { table: 'memberships', columns: ['tenant_id', 'user_id'] },
        ],
      })),
    };
    const keys = await svc.keysFromSourceCatalog(source);
    expect(keys.get('items')).toEqual(['id']);
    expect(keys.get('memberships')).toEqual(['tenant_id', 'user_id']);
    expect(source.query.mock.calls[0][0]).toMatch(/indisprimary/);
  });

  it('is empty when the catalogue lists no keys', async () => {
    const keys = await svc.keysFromSourceCatalog({ query: jest.fn(async () => ({ rows: [] })) });
    expect(keys.size).toBe(0);
  });
});

describe('SupabaseImportKeysService.repairPrimaryKeys', () => {
  const svc = new SupabaseImportKeysService();
  const keys = (entries: Array<[string, string[]]>) => new Map(entries);

  it('leaves a table that already has a key alone', async () => {
    const db = fakeDb({ missing: [] });
    const summary = await svc.repairPrimaryKeys(db, keys([['items', ['id']]]), { tables: ['items'] });
    expect(summary.results).toEqual([{ table: 'items', columns: ['id'], status: 'present' }]);
    expect(db.statements.some((s) => /ALTER TABLE/.test(s))).toBe(false);
  });

  it('reports a table the source describes no key for', async () => {
    const db = fakeDb({ missing: ['log_lines'] });
    const summary = await svc.repairPrimaryKeys(db, keys([]));
    expect(summary.results[0].status).toBe('no_source_key');
    expect(summary.skipped).toBe(1);
  });

  it('reports a key column that does not exist here, without counting anything', async () => {
    const db = fakeDb({ missing: ['items'], columns: { items: ['name'] } });
    const summary = await svc.repairPrimaryKeys(db, keys([['items', ['id']]]));
    expect(summary.results[0]).toMatchObject({ status: 'column_missing', error: 'missing here: id' });
    expect(db.statements.some((s) => /having count/.test(s))).toBe(false);
  });

  it('refuses to key rows that are not unique, and says how many', async () => {
    const db = fakeDb({ missing: ['items'], columns: { items: ['id'] }, duplicates: { items: 3 } });
    const summary = await svc.repairPrimaryKeys(db, keys([['items', ['id']]]));
    expect(summary.results[0]).toMatchObject({ status: 'not_unique', duplicateGroups: 3, nullRows: 0 });
    expect(db.statements.some((s) => /ALTER TABLE/.test(s))).toBe(false);
    expect(svc.describe(summary.results[0])).toMatch(/3 duplicate value group/);
  });

  it('refuses to key rows with a null in the key', async () => {
    const db = fakeDb({ missing: ['items'], columns: { items: ['id'] }, nulls: { items: 2 } });
    const summary = await svc.repairPrimaryKeys(db, keys([['items', ['id']]]));
    expect(summary.results[0]).toMatchObject({ status: 'not_unique', nullRows: 2 });
  });

  it('adds the key in its own transaction with a short lock timeout', async () => {
    const db = fakeDb({ missing: ['memberships'], columns: { memberships: ['tenant_id', 'user_id', 'role'] } });
    const summary = await svc.repairPrimaryKeys(db, keys([['memberships', ['tenant_id', 'user_id']]]));
    expect(summary.results[0]).toMatchObject({
      status: 'added',
      sql: 'ALTER TABLE "public"."memberships" ADD PRIMARY KEY ("tenant_id", "user_id")',
    });
    expect(summary.added).toBe(1);
    const i = db.statements.indexOf('BEGIN');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(db.statements[i + 1]).toMatch(/SET LOCAL lock_timeout = '5s'/);
    expect(db.statements[i + 2]).toMatch(/SET LOCAL statement_timeout/);
    expect(db.statements[i + 3]).toMatch(/^ALTER TABLE/);
    expect(db.statements[i + 4]).toBe('COMMIT');
  });

  it('runs no DDL on a dry run but shows the statement it would run', async () => {
    const db = fakeDb({ missing: ['items'], columns: { items: ['id'] } });
    const summary = await svc.repairPrimaryKeys(db, keys([['items', ['id']]]), { dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.results[0]).toMatchObject({
      status: 'would_add',
      sql: 'ALTER TABLE "public"."items" ADD PRIMARY KEY ("id")',
    });
    expect(summary.wouldAdd).toBe(1);
    expect(db.statements.some((s) => /ALTER TABLE|BEGIN/.test(s))).toBe(false);
  });

  it('rolls back a refused statement, explains a lock, and carries on with the next table', async () => {
    const db = fakeDb({
      missing: ['busy', 'quiet'],
      columns: { busy: ['id'], quiet: ['id'] },
      alterError: { code: '55P03', message: 'canceling statement due to lock timeout' },
    });
    const summary = await svc.repairPrimaryKeys(db, keys([['busy', ['id']], ['quiet', ['id']]]));
    expect(summary.results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(summary.results[0].error).toMatch(/busy/);
    expect(db.statements.filter((s) => s === 'ROLLBACK')).toHaveLength(2);
    expect(summary.examined).toBe(2);
  });

  it('refuses a table filter that is not an identifier before touching the database', async () => {
    const db = fakeDb({ missing: ['items'] });
    await expect(
      svc.repairPrimaryKeys(db, keys([['items', ['id']]]), { tables: ['drop; --'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('only touches the tables named in the filter', async () => {
    const db = fakeDb({ missing: ['a', 'b'], columns: { a: ['id'], b: ['id'] } });
    const summary = await svc.repairPrimaryKeys(db, keys([['a', ['id']], ['b', ['id']]]), { tables: ['b'] });
    expect(summary.results.map((r) => r.table)).toEqual(['b']);
    expect(db.statements.filter((s) => /^ALTER TABLE/.test(s))).toEqual([
      'ALTER TABLE "public"."b" ADD PRIMARY KEY ("id")',
    ]);
  });

  it('returns the rest as pending once the time budget is spent', async () => {
    const db = fakeDb({ missing: ['a', 'b'], columns: { a: ['id'], b: ['id'] } });
    let t = 0;
    const summary = await svc.repairPrimaryKeys(db, keys([['a', ['id']], ['b', ['id']]]), {
      budgetMs: 10,
      now: () => (t += 20),
    });
    expect(summary.results.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(summary.pending).toBe(2);
    expect(db.statements.some((s) => /ALTER TABLE/.test(s))).toBe(false);
  });

  it('adds up its own summary', async () => {
    const db = fakeDb({
      missing: ['added', 'dupes', 'nokey'],
      columns: { added: ['id'], dupes: ['id'], nokey: ['id'] },
      duplicates: { dupes: 1 },
    });
    const summary = await svc.repairPrimaryKeys(db, keys([['added', ['id']], ['dupes', ['id']]]));
    expect(summary).toMatchObject({ examined: 3, added: 1, skipped: 2, failed: 0, pending: 0, wouldAdd: 0 });
  });
});
