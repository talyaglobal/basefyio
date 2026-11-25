import {
  ADVISOR_ROW_LIMIT,
  ADVISOR_RULES,
  EXCLUDED_SCHEMAS,
  countFindings,
  noPrimaryKeyRule,
  qualified,
  quoteIdent,
  rlsDisabledRule,
  rlsNoPolicyRule,
  securityDefinerSearchPathRule,
  sortFindings,
  truncateIdent,
  unindexedForeignKeyRule,
  unusedIndexRule,
} from './advisor-rules';

describe('quoteIdent', () => {
  it('leaves plain lower-case names bare', () => {
    expect(quoteIdent('todos')).toBe('todos');
    expect(quoteIdent('user_id')).toBe('user_id');
  });

  it('quotes upper case, spaces, reserved words and leading digits', () => {
    expect(quoteIdent('Todos')).toBe('"Todos"');
    expect(quoteIdent('my table')).toBe('"my table"');
    expect(quoteIdent('user')).toBe('"user"');
    expect(quoteIdent('order')).toBe('"order"');
    expect(quoteIdent('1st')).toBe('"1st"');
  });

  it('doubles embedded double quotes', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteIdent('x"; DROP TABLE y; --')).toBe('"x""; DROP TABLE y; --"');
    expect(qualified('Sales', 'Order "x"')).toBe('"Sales"."Order ""x"""');
  });

  it('cuts identifiers at 63 bytes on a character boundary', () => {
    expect(truncateIdent('a'.repeat(80))).toHaveLength(63);
    const cut = truncateIdent('ş'.repeat(40)); // 2 bytes each
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(63);
    expect(cut).toBe('ş'.repeat(31));
  });
});

describe('rule SQL', () => {
  it.each(ADVISOR_RULES.map((r) => [r.id, r] as const))('%s is one bounded catalog SELECT', (_id, rule) => {
    const sql = rule.sql.trim();
    expect(sql).toMatch(/^(SELECT|WITH)\b/);
    expect(sql).toContain(`LIMIT ${ADVISOR_ROW_LIMIT}`);
    expect(sql).not.toContain(';');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE|TRUNCATE)\s/);
    for (const s of ['auth', 'storage', 'extensions', 'information_schema', 'realtime']) {
      expect(sql).toContain(`'${s}'`);
    }
    expect(sql).toContain("NOT LIKE 'pg\\_%'");
    expect(sql).toContain("NOT LIKE '\\_bf\\_%'");
  });

  it('excludes the platform schemas', () => {
    expect(EXCLUDED_SCHEMAS).toEqual(expect.arrayContaining(['auth', 'storage', 'extensions', 'pg_catalog']));
  });

  it('rule ids are unique', () => {
    const ids = ADVISOR_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('rls_disabled', () => {
  it('is an error when anon or authenticated may write', () => {
    const [f] = rlsDisabledRule.map([{ schema: 'public', table: 'todos', writers: ['anon', 'authenticated'] }]);
    expect(f).toMatchObject({
      id: 'rls_disabled:public.todos',
      severity: 'error',
      category: 'security',
      entity: 'public.todos',
    });
    expect(f.detail).toContain('anon and authenticated roles');
    expect(f.fixSql.split('\n')[0]).toBe('ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;');
  });

  it('is a warning without public writers, and accepts the text array form', () => {
    const [f] = rlsDisabledRule.map([{ schema: 'public', table: 'Notes', writers: '{}' }]);
    expect(f.severity).toBe('warn');
    expect(f.fixSql).toContain('ALTER TABLE public."Notes" ENABLE ROW LEVEL SECURITY;');
    const [g] = rlsDisabledRule.map([{ schema: 'public', table: 't', writers: '{anon}' }]);
    expect(g.severity).toBe('error');
  });
});

describe('rls_enabled_no_policy', () => {
  it('suggests a policy on a quoted table', () => {
    const [f] = rlsNoPolicyRule.map([{ schema: 'app', table: 'User Data' }]);
    expect(f).toMatchObject({ severity: 'info', category: 'security', entity: 'app.User Data' });
    expect(f.fixSql).toContain('CREATE POLICY "authenticated can read" ON app."User Data"');
  });
});

describe('unindexed_foreign_key', () => {
  it('builds a CREATE INDEX on the key columns', () => {
    const [f] = unindexedForeignKeyRule.map([
      { schema: 'public', table: 'comments', constraint: 'comments_post_id_fkey', columns: ['post_id'] },
    ]);
    expect(f).toMatchObject({
      id: 'unindexed_foreign_key:public.comments.comments_post_id_fkey',
      severity: 'warn',
      category: 'performance',
      entity: 'public.comments',
    });
    expect(f.fixSql).toBe('CREATE INDEX IF NOT EXISTS comments_post_id_idx ON public.comments (post_id);');
  });

  it('quotes multi-column, mixed-case and quote-bearing names', () => {
    const [f] = unindexedForeignKeyRule.map([
      { schema: 'Shop', table: 'Order"Lines', constraint: 'fk', columns: '{OrderId,"line no"}' },
    ]);
    expect(f.fixSql).toBe(
      'CREATE INDEX IF NOT EXISTS "Order""Lines_OrderId_line no_idx" ON "Shop"."Order""Lines" ("OrderId", "line no");',
    );
  });
});

describe('security_definer_search_path', () => {
  it('pins the search_path with the function signature', () => {
    const [f] = securityDefinerSearchPathRule.map([{ schema: 'public', name: 'GetUser', args: 'uid uuid, n integer' }]);
    expect(f).toMatchObject({ severity: 'warn', category: 'security', entity: 'public.GetUser(uid uuid, n integer)' });
    expect(f.fixSql).toBe('ALTER FUNCTION public."GetUser"(uid uuid, n integer) SET search_path = public, pg_temp;');
  });
});

describe('unused_index', () => {
  it('suggests dropping the index', () => {
    const [f] = unusedIndexRule.map([
      { schema: 'public', table: 'events', index: 'events_Kind_idx', index_bytes: 5 * 1024 * 1024, stats_since: new Date('2026-10-01T00:00:00Z') },
    ]);
    expect(f).toMatchObject({ severity: 'info', category: 'performance', entity: 'public.events_Kind_idx' });
    expect(f.detail).toContain('5.0 MB');
    expect(f.detail).toContain('2026-10-01');
    expect(f.fixSql).toBe('DROP INDEX IF EXISTS public."events_Kind_idx";');
  });

  it('ignores unique, primary, constraint and FK-covering indexes and small tables in SQL', () => {
    const sql = unusedIndexRule.sql;
    expect(sql).toContain('s.idx_scan = 0');
    expect(sql).toContain('NOT i.indisunique');
    expect(sql).toContain('NOT i.indisprimary');
    expect(sql).toContain('ic.conindid = s.indexrelid');
    expect(sql).toContain("con.contype = 'f'");
    expect(sql).toContain('pg_relation_size(s.relid) >=');
    expect(sql).toContain('stats_reset');
  });
});

describe('no_primary_key', () => {
  it('adds an identity column, or a key on an existing id', () => {
    const [a] = noPrimaryKeyRule.map([{ schema: 'public', table: 'logs', has_id: false }]);
    expect(a.fixSql).toBe('ALTER TABLE public.logs ADD COLUMN id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY;');
    const [b] = noPrimaryKeyRule.map([{ schema: 'public', table: 'logs', has_id: true }]);
    expect(b.fixSql).toContain('ALTER TABLE public.logs ADD PRIMARY KEY (id);');
  });
});

describe('sorting and counts', () => {
  it('orders by category then severity and counts both', () => {
    const findings = [
      ...unindexedForeignKeyRule.map([{ schema: 'public', table: 'b', constraint: 'fk', columns: ['a_id'] }]),
      ...rlsNoPolicyRule.map([{ schema: 'public', table: 'c' }]),
      ...rlsDisabledRule.map([{ schema: 'public', table: 'b', writers: ['anon'] }]),
    ];
    const sorted = sortFindings(findings);
    expect(sorted.map((f) => f.ruleId)).toEqual(['unindexed_foreign_key', 'rls_disabled', 'rls_enabled_no_policy']);
    expect(countFindings(sorted)).toEqual({ total: 3, error: 1, warn: 1, info: 1, security: 2, performance: 1 });
  });
});
