import { findForbiddenSqlPattern } from './sql-guard';

describe('findForbiddenSqlPattern', () => {
  it('allows ordinary SELECT / DML for any caller', () => {
    expect(findForbiddenSqlPattern('SELECT * FROM customers WHERE id = 1')).toBeNull();
    expect(findForbiddenSqlPattern('UPDATE orders SET status = 1 WHERE id = 2')).toBeNull();
  });

  // DDL used to pass with no role given. It now depends on who is asking, and
  // the parameter defaults to the narrowest caller, so the editor says so.
  it('allows DDL for the dashboard editor', () => {
    expect(findForbiddenSqlPattern('CREATE TABLE t (id int)', 'owner')).toBeNull();
  });

  it('blocks role / database / user statements', () => {
    expect(findForbiddenSqlPattern('DROP DATABASE prod')).toBe('DROP DATABASE');
    expect(findForbiddenSqlPattern('create role hacker')).toBe('CREATE ROLE');
    expect(findForbiddenSqlPattern('GRANT ALL ON t TO x')).toBe('GRANT ');
  });

  it('blocks server-side file / program / FDW access', () => {
    expect(findForbiddenSqlPattern('SELECT pg_read_file(\'/etc/passwd\')')).toBe('pg_read_file');
    expect(findForbiddenSqlPattern('COPY t FROM PROGRAM \'sh\'')).not.toBeNull();
    expect(findForbiddenSqlPattern('SELECT dblink(\'x\',\'y\')')).toBe('DBLINK');
  });

  it('normalizes interspersed comments so a split token is still caught', () => {
    // A real statement obfuscated with an inline comment must still be blocked.
    expect(findForbiddenSqlPattern('DROP/**/DATABASE prod')).toBe('DROP DATABASE');
  });

  it('ignores a forbidden token that lives entirely inside a comment (it never executes)', () => {
    expect(findForbiddenSqlPattern('SELECT 1; /* DROP DATABASE prod */')).toBeNull();
    expect(findForbiddenSqlPattern('SELECT 1 -- DROP ROLE x\n')).toBeNull();
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(findForbiddenSqlPattern('  aLtEr    system SET x=1')).toBe('ALTER SYSTEM');
  });
});

/**
 * Who may change the shape of the database.
 *
 * The denylist above is global, which left DDL out of it on purpose — the SQL
 * editor is how an owner shapes their schema. But the same route is reachable
 * with a project's anon key, which ships inside every browser bundle, and for
 * that caller DDL is not a feature. The policy verbs are the sharpest case: a
 * caller who can run ALTER POLICY, or disable row level security, removes the
 * mechanism that bounds them, and one who can CREATE FUNCTION can write a
 * SECURITY DEFINER function and call it back through rpc to run as the owner.
 */
describe('findForbiddenSqlPattern — owner-only statements', () => {
  const ddl = [
    'CREATE TABLE t (id int)',
    'ALTER TABLE t ADD COLUMN x int',
    'DROP TABLE t',
    'TRUNCATE t',
    'CREATE INDEX i ON t (id)',
  ];
  const policy = [
    'CREATE POLICY p ON t USING (true)',
    'ALTER POLICY p ON t USING (true)',
    'DROP POLICY p ON t',
    'ALTER TABLE t DISABLE ROW LEVEL SECURITY',
  ];
  const escalation = [
    'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql SECURITY DEFINER',
    'CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql',
    'CREATE TRIGGER tr AFTER INSERT ON t EXECUTE FUNCTION f()',
  ];

  describe.each([
    ['anon', 'anon' as const],
    ['authenticated', 'authenticated' as const],
  ])('a caller running as %s', (_label, role) => {
    it.each([...ddl, ...policy, ...escalation])('is refused: %s', (sql) => {
      expect(findForbiddenSqlPattern(sql, role)).not.toBeNull();
    });

    it('may still read and write rows', () => {
      expect(findForbiddenSqlPattern('SELECT * FROM t WHERE id = 1', role)).toBeNull();
      expect(findForbiddenSqlPattern('INSERT INTO t (id) VALUES (1)', role)).toBeNull();
      expect(findForbiddenSqlPattern('UPDATE t SET id = 2 WHERE id = 1', role)).toBeNull();
      expect(findForbiddenSqlPattern('DELETE FROM t WHERE id = 1', role)).toBeNull();
    });
  });

  describe.each([
    ['the dashboard SQL editor', 'owner' as const],
    ['the project service key', 'service_role' as const],
  ])('%s', (_label, role) => {
    it.each([...ddl, ...policy, ...escalation])('keeps working: %s', (sql) => {
      expect(findForbiddenSqlPattern(sql, role)).toBeNull();
    });

    it('is still refused the statements that reach outside the database', () => {
      expect(findForbiddenSqlPattern('CREATE ROLE evil', role)).toBe('CREATE ROLE');
      expect(findForbiddenSqlPattern("COPY t FROM '/etc/passwd'", role)).toBe('COPY ');
      expect(findForbiddenSqlPattern('ALTER SYSTEM SET x = 1', role)).toBe('ALTER SYSTEM');
    });
  });

  /**
   * A caller that forgets to say who it is should get less, not more. The
   * parameter defaults to the narrowest role for that reason.
   */
  it('assumes the narrowest caller when the role is not given', () => {
    expect(findForbiddenSqlPattern('DROP TABLE t')).toBe('DROP TABLE');
  });

  /**
   * Comments are stripped so a keyword split by one still matches — that is
   * the evasion the stripping is there to defeat, rather than a mention of an
   * operation inside a comment, which is harmless and stays allowed.
   */
  it('catches a keyword broken up by a comment', () => {
    expect(findForbiddenSqlPattern('DROP/**/TABLE t', 'anon')).toBe('DROP TABLE');
    expect(findForbiddenSqlPattern('ALTER/* x */POLICY p ON t', 'anon')).toBe('ALTER POLICY');
  });

  it('does not refuse a statement that merely mentions one in a comment', () => {
    expect(findForbiddenSqlPattern('SELECT 1 -- we could ALTER POLICY here', 'anon')).toBeNull();
  });
});
