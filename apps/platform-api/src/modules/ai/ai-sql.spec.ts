import {
  analyzeStatement,
  extractSqlBlocks,
  isReadOnlyScript,
  normalizeProposal,
  parseQualifiedName,
  quoteQualified,
  splitStatements,
  verificationTargets,
} from './ai-sql';

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    const script = `
      CREATE TABLE a (id int); -- trailing; comment
      INSERT INTO a VALUES (1), (2);
      SELECT 'x;y', "we;ird", $$ body; $$ , $fn$ more; $fn$;
      /* block; comment */
    `;
    expect(splitStatements(script)).toEqual([
      'CREATE TABLE a (id int)',
      '-- trailing; comment\n      INSERT INTO a VALUES (1), (2)',
      `SELECT 'x;y', "we;ird", $$ body; $$ , $fn$ more; $fn$`,
    ]);
  });

  it('keeps function bodies whole', () => {
    const fn = `CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$`;
    expect(splitStatements(`${fn};SELECT 1`)).toEqual([fn, 'SELECT 1']);
  });

  it('handles escaped quotes and E-strings', () => {
    expect(splitStatements(`SELECT 'it''s; fine'; SELECT E'a\\';b'`)).toEqual([
      `SELECT 'it''s; fine'`,
      `SELECT E'a\\';b'`,
    ]);
  });

  it('does not treat $1 as a dollar quote', () => {
    expect(splitStatements('SELECT $1; SELECT 2')).toEqual(['SELECT $1', 'SELECT 2']);
  });
});

describe('analyzeStatement', () => {
  it.each([
    ['SELECT * FROM posts', 'read'],
    ['with x as (select 1) select * from x', 'read'],
    ['EXPLAIN SELECT 1', 'read'],
    ['SHOW search_path', 'read'],
    ['WITH d AS (DELETE FROM posts RETURNING *) SELECT * FROM d', 'write'],
    ['SELECT * INTO copy FROM posts', 'schema'],
    ['EXPLAIN ANALYZE DELETE FROM posts', 'write'],
    ['SELECT * FROM posts FOR UPDATE', 'write'],
    ['INSERT INTO posts (title) VALUES ($$x$$)', 'write'],
    ['UPDATE posts SET title = 1 WHERE id = 2', 'write'],
    ['CREATE TABLE posts (id int)', 'schema'],
    ['ALTER TABLE posts ENABLE ROW LEVEL SECURITY', 'schema'],
    ['DO $$ BEGIN END $$', 'schema'],
    ['COMMIT', 'transaction'],
    ['SET TRANSACTION READ WRITE', 'transaction'],
    ['VACUUM posts', 'other'],
  ])('%s → %s', (sql, kind) => {
    expect(analyzeStatement(sql).kind).toBe(kind);
  });

  it('ignores keywords inside strings and comments', () => {
    expect(analyzeStatement(`SELECT 'delete from x' -- update y`).kind).toBe('read');
  });

  it('flags destructive statements', () => {
    expect(analyzeStatement('DROP TABLE posts').destructive).toBe(true);
    expect(analyzeStatement('TRUNCATE posts').destructive).toBe(true);
    expect(analyzeStatement('DELETE FROM posts').warning).toMatch(/every row/);
    expect(analyzeStatement('UPDATE posts SET a = 1').warning).toMatch(/every row/);
    expect(analyzeStatement('ALTER TABLE posts DROP COLUMN body').destructive).toBe(true);
    expect(analyzeStatement('ALTER TABLE posts DISABLE ROW LEVEL SECURITY').destructive).toBe(true);
    expect(
      analyzeStatement('CREATE POLICY p ON posts FOR ALL USING (true)').warning,
    ).toMatch(/every row/);
    expect(analyzeStatement('CREATE POLICY r ON posts FOR SELECT USING (true)').destructive).toBe(false);
    expect(analyzeStatement('CREATE TABLE posts (id int)').destructive).toBe(false);
    expect(analyzeStatement('UPDATE posts SET a = 1 WHERE id = 1').destructive).toBe(false);
  });

  it('names the command', () => {
    expect(analyzeStatement('CREATE UNIQUE INDEX i ON t (a)').command).toBe('CREATE INDEX');
    expect(analyzeStatement('create or replace function f() returns int as $$ select 1 $$ language sql').command).toBe(
      'CREATE FUNCTION',
    );
    expect(analyzeStatement('CREATE MATERIALIZED VIEW v AS SELECT 1').command).toBe('CREATE MATERIALIZED VIEW');
    expect(analyzeStatement('delete from t where id = 1').command).toBe('DELETE');
  });
});

describe('isReadOnlyScript', () => {
  it('is read-only only when every statement reads', () => {
    expect(isReadOnlyScript(['SELECT 1', 'SHOW x'].map(analyzeStatement))).toBe(true);
    expect(isReadOnlyScript(['SELECT 1', 'DELETE FROM t'].map(analyzeStatement))).toBe(false);
    expect(isReadOnlyScript([])).toBe(false);
  });
});

describe('extractSqlBlocks', () => {
  it('takes sql-tagged fences only', () => {
    const text = 'a\n```sql\nSELECT 1;\n```\n```js\nx()\n```\n```postgresql\nSELECT 2\n```';
    expect(extractSqlBlocks(text)).toEqual(['SELECT 1;', 'SELECT 2']);
  });
});

describe('normalizeProposal', () => {
  it('drops BEGIN/COMMIT wrappers', () => {
    const { statements, error } = normalizeProposal('BEGIN; CREATE TABLE a (id int); COMMIT;');
    expect(error).toBeNull();
    expect(statements.map((s) => s.sql)).toEqual(['CREATE TABLE a (id int)']);
  });

  it('refuses ROLLBACK and SAVEPOINT inside a change', () => {
    expect(normalizeProposal('INSERT INTO a VALUES (1); ROLLBACK').error).toMatch(/ROLLBACK/);
    expect(normalizeProposal('SAVEPOINT s').error).toMatch(/SAVEPOINT/);
  });

  it('refuses an empty script', () => {
    expect(normalizeProposal('-- nothing').error).toMatch(/no statements/);
  });
});

describe('qualified names', () => {
  it('lower-cases bare names and keeps quoted case', () => {
    expect(parseQualifiedName('Public.Posts')).toEqual({ schema: 'public', name: 'posts' });
    expect(parseQualifiedName('"MySchema"."My Table"')).toEqual({ schema: 'MySchema', name: 'My Table' });
    expect(parseQualifiedName('posts')).toEqual({ schema: null, name: 'posts' });
    expect(quoteQualified({ schema: 'a', name: 'b"c' })).toBe('"a"."b""c"');
  });
});

describe('verificationTargets', () => {
  it('checks created tables, indexes, views and functions', () => {
    expect(verificationTargets('CREATE TABLE IF NOT EXISTS public.posts (id int)')).toEqual([
      { type: 'relation_exists', relation: { schema: 'public', name: 'posts' }, label: 'table' },
    ]);
    expect(verificationTargets('CREATE UNIQUE INDEX CONCURRENTLY idx_a ON posts (a)')[0]).toMatchObject({
      type: 'relation_exists',
      relation: { name: 'idx_a' },
    });
    expect(verificationTargets('create or replace view v as select 1')[0]).toMatchObject({ label: 'view' });
    expect(verificationTargets('CREATE FUNCTION app.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql')).toEqual([
      { type: 'function_exists', fn: { schema: 'app', name: 'f' } },
    ]);
  });

  it('checks RLS switches and policies', () => {
    expect(verificationTargets('ALTER TABLE posts ENABLE ROW LEVEL SECURITY')).toEqual([
      { type: 'rls_enabled', relation: { schema: null, name: 'posts' }, enabled: true },
    ]);
    expect(verificationTargets('CREATE POLICY "Owners write" ON public.posts FOR INSERT WITH CHECK (true)')).toEqual([
      { type: 'policy_exists', policy: 'Owners write', relation: { schema: 'public', name: 'posts' } },
    ]);
    expect(verificationTargets('DROP POLICY IF EXISTS p ON posts')).toEqual([
      { type: 'policy_absent', policy: 'p', relation: { schema: null, name: 'posts' } },
    ]);
  });

  it('checks added and dropped columns and dropped tables', () => {
    expect(
      verificationTargets('ALTER TABLE posts ADD COLUMN owner_id text DEFAULT auth.uid(), ADD CONSTRAINT c CHECK (true)'),
    ).toEqual([{ type: 'column_exists', relation: { schema: null, name: 'posts' }, column: 'owner_id' }]);
    expect(verificationTargets('ALTER TABLE posts DROP COLUMN IF EXISTS body')).toEqual([
      { type: 'column_absent', relation: { schema: null, name: 'posts' }, column: 'body' },
    ]);
    expect(verificationTargets('DROP TABLE IF EXISTS a, public.b CASCADE')).toEqual([
      { type: 'relation_absent', relation: { schema: null, name: 'a' }, label: 'object' },
      { type: 'relation_absent', relation: { schema: 'public', name: 'b' }, label: 'object' },
    ]);
  });

  it('has nothing to check for row changes', () => {
    expect(verificationTargets('INSERT INTO posts VALUES (1)')).toEqual([]);
  });
});
