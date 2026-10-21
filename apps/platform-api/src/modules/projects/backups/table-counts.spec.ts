import {
  LIST_USER_TABLES_SQL,
  collectTableCounts,
  compareTableCounts,
  listUserTables,
  quoteIdent,
} from './table-counts';

/**
 * A pg client that answers the table listing and per-table counts, records
 * every statement, and can be told to fail a given table's count.
 */
function fakeClient(tables: Array<{ schema: string; table: string; rows?: number; fail?: boolean }>) {
  const statements: string[] = [];
  const query = jest.fn(async (sql: string) => {
    statements.push(sql.trim());
    if (sql.includes('from pg_class')) {
      return { rows: tables.map((t) => ({ schema: t.schema, table: t.table })) };
    }
    const m = sql.match(/from (.+)$/s);
    if (sql.startsWith('select count(*)') && m) {
      const t = tables.find((x) => `${quoteIdent(x.schema)}.${quoteIdent(x.table)}` === m[1].trim());
      if (!t) throw new Error(`unknown table ${m[1]}`);
      if (t.fail) throw new Error('canceling statement due to statement timeout');
      return { rows: [{ n: String(t.rows ?? 0) }] };
    }
    return { rows: [] };
  });
  return { query, statements };
}

describe('collectTableCounts', () => {
  it('counts every user table inside its own savepoint', async () => {
    const client = fakeClient([
      { schema: 'public', table: 'users', rows: 3 },
      { schema: 'app', table: 'orders', rows: 10 },
    ]);
    const out = await collectTableCounts(client, { snapshot: '0000000A-1', now: () => new Date('2026-10-20T03:00:00Z') });

    expect(out).toEqual({
      formatVersion: 1,
      snapshot: '0000000A-1',
      countedAt: '2026-10-20T03:00:00.000Z',
      truncated: false,
      tables: [
        { schema: 'public', table: 'users', rows: 3 },
        { schema: 'app', table: 'orders', rows: 10 },
      ],
    });
    const savepoints = client.statements.filter((s) => s === 'SAVEPOINT bf_count').length;
    const releases = client.statements.filter((s) => s === 'RELEASE SAVEPOINT bf_count').length;
    expect(savepoints).toBe(2);
    expect(releases).toBe(2);
    expect(client.statements.some((s) => s.startsWith('SET LOCAL statement_timeout = 20000'))).toBe(true);
  });

  it('rolls back only the failed count and keeps going', async () => {
    const client = fakeClient([
      { schema: 'public', table: 'huge', fail: true },
      { schema: 'public', table: 'small', rows: 1 },
    ]);
    const out = await collectTableCounts(client, { perTableTimeoutMs: 5 });
    expect(out.tables).toEqual([
      { schema: 'public', table: 'huge', rows: null },
      { schema: 'public', table: 'small', rows: 1 },
    ]);
    expect(client.statements).toContain('ROLLBACK TO SAVEPOINT bf_count');
    expect(client.statements.filter((s) => s === 'RELEASE SAVEPOINT bf_count')).toHaveLength(1);
    expect(client.statements.some((s) => s.startsWith('SET LOCAL statement_timeout = 5'))).toBe(true);
  });

  it('lists but does not count tables beyond maxTables', async () => {
    const client = fakeClient([
      { schema: 'public', table: 'a', rows: 1 },
      { schema: 'public', table: 'b', rows: 2 },
      { schema: 'public', table: 'c', rows: 3 },
    ]);
    const out = await collectTableCounts(client, { maxTables: 2 });
    expect(out.truncated).toBe(true);
    expect(out.tables.map((t) => t.rows)).toEqual([1, 2, null]);
    expect(client.statements.filter((s) => s.startsWith('select count(*)'))).toHaveLength(2);
  });

  it('quotes identifiers so odd names cannot break out', async () => {
    const client = fakeClient([{ schema: 'we"ird', table: 'tab le', rows: 4 }]);
    const out = await collectTableCounts(client);
    expect(out.tables[0]).toEqual({ schema: 'we"ird', table: 'tab le', rows: 4 });
    expect(client.statements.some((s) => s.includes('"we""ird"."tab le"'))).toBe(true);
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('lists ordinary and partitioned tables but not partitions or system schemas', async () => {
    const client = fakeClient([{ schema: 'public', table: 't' }]);
    await listUserTables(client);
    expect(client.query).toHaveBeenCalledWith(LIST_USER_TABLES_SQL);
    expect(LIST_USER_TABLES_SQL).toMatch(/relkind in \('r', 'p'\)/);
    expect(LIST_USER_TABLES_SQL).toMatch(/not c\.relispartition/);
    expect(LIST_USER_TABLES_SQL).toMatch(/pg_catalog/);
  });
});

describe('compareTableCounts', () => {
  const expected = [
    { schema: 'public', table: 'users', rows: 3 },
    { schema: 'public', table: 'orders', rows: 10 },
    { schema: 'public', table: 'unknown_count', rows: null },
    { schema: 'public', table: 'gone', rows: 1 },
  ];

  it('reports missing tables, mismatched counts and how many were compared', () => {
    const actual = [
      { schema: 'public', table: 'users', rows: 3 },
      { schema: 'public', table: 'orders', rows: 9 },
      { schema: 'public', table: 'unknown_count', rows: 7 },
      { schema: 'public', table: 'extra', rows: 1 },
    ];
    expect(compareTableCounts(expected, actual)).toEqual({
      missingTables: ['public.gone'],
      mismatches: [{ schema: 'public', table: 'orders', expected: 10, actual: 9 }],
      compared: 2,
    });
  });

  it('is clean when everything matches', () => {
    const actual = expected.filter((t) => t.table !== 'gone').concat([{ schema: 'public', table: 'gone', rows: 1 }]);
    expect(compareTableCounts(expected, actual)).toEqual({ missingTables: [], mismatches: [], compared: 3 });
  });

  it('skips tables whose restored count is unknown', () => {
    const actual = [{ schema: 'public', table: 'users', rows: null }];
    const r = compareTableCounts([{ schema: 'public', table: 'users', rows: 3 }], actual);
    expect(r).toEqual({ missingTables: [], mismatches: [], compared: 0 });
  });
});
