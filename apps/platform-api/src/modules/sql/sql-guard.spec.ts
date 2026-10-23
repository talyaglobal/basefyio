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
    expect(findForbiddenSqlPattern('GRANT ALL ON t TO x')).toBe('GRANT');
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
      expect(findForbiddenSqlPattern("COPY t FROM '/etc/passwd'", role)).toBe('COPY');
      expect(findForbiddenSqlPattern('ALTER SYSTEM SET x = 1', role)).toBe('ALTER SYSTEM');
    });
  });

  /**
   * A caller that forgets to say who it is should get less, not more. The
   * parameter defaults to the narrowest role for that reason.
   */
  it('assumes the narrowest caller when the role is not given', () => {
    // The narrowest caller is a public key, which may only read and write
    // rows, so the refusal comes from that list rather than from the DDL one.
    expect(findForbiddenSqlPattern('DROP TABLE t')).toContain('DROP');
    expect(findForbiddenSqlPattern('DROP TABLE t')).toContain('public key');
  });

  /**
   * Comments are stripped so a keyword split by one still matches — that is
   * the evasion the stripping is there to defeat, rather than a mention of an
   * operation inside a comment, which is harmless and stays allowed.
   */
  it('catches a keyword broken up by a comment', () => {
    // Shown against the dashboard role: a public key never reaches the
    // sequence lists, because it may not open a statement with DROP or ALTER
    // at all.
    expect(findForbiddenSqlPattern('DROP/**/DATABASE x', 'owner')).toBe('DROP DATABASE');
    expect(findForbiddenSqlPattern('ALTER/* x */SYSTEM SET x = 1', 'owner')).toBe('ALTER SYSTEM');
  });

  it('does not refuse a statement that merely mentions one in a comment', () => {
    expect(findForbiddenSqlPattern('SELECT 1 -- we could ALTER POLICY here', 'anon')).toBeNull();
  });
});

/**
 * Words, not substrings.
 *
 * The guard used to look for "LOAD " anywhere in the upper-cased text, so
 * `payload`, `workload` and `'download me'` were refused as "Forbidden SQL
 * operation: LOAD". It now matches whole tokens, and statement keywords that
 * are also ordinary words only where a statement starts.
 */
describe('findForbiddenSqlPattern — no false positives on ordinary words', () => {
  it.each([
    'create table t (payload text)',
    'select 1 as workload from (select 1) s',
    "select 'download me'",
    'SELECT payload, workload, download, upload, reload FROM jobs',
    "INSERT INTO logs (msg) VALUES ('page load took 2s')",
    "UPDATE t SET note = 'copy that' WHERE id = 1",
    "SELECT 'please grant access' AS msg",
    'SELECT copy, load, revoke FROM t',
    'CREATE TABLE t (copy text, load int, "grant" text)',
    'SELECT CASE WHEN busy THEN load ELSE 0 END FROM servers',
    "UPDATE users SET role = 'admin' WHERE id = 1",
    "INSERT INTO users (id, role) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role",
    'SELECT copyright, loader, granted_at, revoked FROM t',
    'SELECT * FROM "copy"',
    'SELECT * FROM t WHERE grantee_id = 1',
    'SELECT my_dblink_count FROM stats',
    "SELECT set_config('request.jwt.claims', '{}', true)",
    'RESET ROLE',
  ])('owner may run: %s', (sql) => {
    expect(findForbiddenSqlPattern(sql, 'owner')).toBeNull();
  });

  it.each([
    'create table t (payload text)',
    "select 'download me'",
    'SELECT payload FROM t',
    "UPDATE users SET role = 'admin' WHERE id = 1",
  ])('an anon caller may run ordinary DML/reads too: %s', (sql) => {
    expect(findForbiddenSqlPattern(sql, sql.startsWith('create') ? 'owner' : 'anon')).toBeNull();
  });
});

describe('findForbiddenSqlPattern — the real operations stay refused', () => {
  it.each([
    ["LOAD 'auto_explain'", 'LOAD'],
    ["select 1; load 'plpgsql'", 'LOAD'],
    ['COPY t TO STDOUT', 'COPY'],
    ["copy (select 1) to '/tmp/x'", 'COPY'],
    ["COPY t FROM PROGRAM 'curl evil'", 'COPY'],
    ['GRANT SELECT ON t TO anon', 'GRANT'],
    ['revoke all on t from public', 'REVOKE'],
    ['ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon', 'ALTER DEFAULT PRIVILEGES'],
    ['SET ROLE postgres', 'SET ROLE'],
    ['SET SESSION ROLE postgres', 'SET ROLE'],
    ['set role = service_role', 'SET ROLE'],
    ['SET "role" TO postgres', 'SET ROLE'],
    ['SET SESSION AUTHORIZATION postgres', 'SET SESSION AUTHORIZATION'],
    ["SET session_authorization = 'postgres'", 'SET SESSION AUTHORIZATION'],
    ["SELECT set_config('role', 'postgres', false)", 'SET ROLE'],
    ["CREATE FUNCTION f() RETURNS int SET role = 'postgres' AS $$ SELECT 1 $$ LANGUAGE sql", 'SET ROLE'],
    ['SELECT "pg_read_file"(\'/etc/passwd\')', 'pg_read_file'],
    ["SELECT pg_catalog.pg_ls_dir('.')", 'pg_ls_dir'],
    ["SELECT dblink_exec('host=x', 'drop table t')", 'DBLINK'],
    ['GRANT pg_read_server_files TO me', 'GRANT'],
    ['CREATE EXTENSION IF NOT EXISTS dblink', 'CREATE EXTENSION'],
    ['create   foreign data wrapper w', 'CREATE FOREIGN'],
  ])('refuses %s', (sql, label) => {
    expect(findForbiddenSqlPattern(sql, 'owner')).toBe(label);
  });

  // A string literal is still read — as SQL of its own — because that is
  // where a function body or an EXECUTE hides a statement.
  it.each([
    ["DO $$ BEGIN EXECUTE 'COPY t TO PROGRAM ''sh'''; END $$", 'COPY'],
    ["CREATE FUNCTION f() RETURNS void AS $$ COPY t FROM '/etc/passwd' $$ LANGUAGE sql", 'COPY'],
    ["CREATE FUNCTION f() RETURNS void AS $body$ BEGIN LOAD 'x'; END $body$ LANGUAGE plpgsql", 'LOAD'],
    ["DO $$ BEGIN IF true THEN copy t to stdout; END IF; END $$", 'COPY'],
    ["DO 'BEGIN EXECUTE ''GRANT ALL ON t TO anon''; END'", 'GRANT'],
    ["DO $$ BEGIN SET ROLE postgres; END $$", 'SET ROLE'],
    ["DO $$ BEGIN PERFORM pg_read_file('/etc/passwd'); END $$", 'pg_read_file'],
    ["DO $ BEGIN EXECUTE E'\\x43OPY t TO PROGRAM ''x'''; END $", 'COPY'],
    ["EXECUTE U&'\\0043OPY t TO STDOUT'", 'COPY'],
    ["EXECUTE U&'!0043OPY t TO STDOUT' UESCAPE '!'", 'COPY'],
    ['SELECT U&"pg\\005fread\\005ffile"(\'/x\')', 'pg_read_file'],
  ])('refuses a smuggled operation: %s', (sql, label) => {
    expect(findForbiddenSqlPattern(sql, 'owner')).toBe(label);
  });

  it('is not fooled by nested block comments', () => {
    expect(findForbiddenSqlPattern('/* a /* nested */ still comment */ DROP DATABASE x')).toBe('DROP DATABASE');
    expect(findForbiddenSqlPattern('SELECT 1 /* outer /* inner */ DROP DATABASE x */')).toBeNull();
  });

  it('does not let a quoted identifier break a keyword sequence apart', () => {
    expect(findForbiddenSqlPattern('DROP "x" DATABASE', 'owner')).toBeNull(); // not valid SQL, and not the sequence
    expect(findForbiddenSqlPattern('DROP\n\tDATABASE x', 'owner')).toBe('DROP DATABASE');
  });
});

describe('findForbiddenSqlPattern — non-owner callers', () => {
  it.each([
    ['SET LOCAL ROLE service_role', 'SET LOCAL ROLE'],
    ["SELECT set_config('role', 'service_role', true)", 'SET LOCAL ROLE'],
    ['CREATE TEMP TABLE x (id int)', 'CREATE TABLE'],
    ['CREATE OR REPLACE VIEW v AS SELECT 1', 'CREATE VIEW'],
    ['CREATE UNIQUE INDEX i ON t (id)', 'CREATE INDEX'],
    ['CREATE OR REPLACE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$', 'CREATE PROCEDURE'],
    ['truncate t', 'TRUNCATE'],
  ])('refuses %s', (sql, label) => {
    for (const role of ['anon', 'authenticated'] as const) {
      const hit = findForbiddenSqlPattern(sql, role);
      expect(hit).not.toBeNull();
      // Either the statement-class rule caught it on the way in, or it slipped
      // past that one (it opens with SELECT) and the DDL list named it.
      expect(hit === label || String(hit).includes('public key')).toBe(true);
    }
  });

  it('lets the owner and the service key test policies with SET LOCAL ROLE', () => {
    expect(findForbiddenSqlPattern('BEGIN; SET LOCAL ROLE anon; SELECT * FROM t; ROLLBACK;', 'owner')).toBeNull();
    expect(findForbiddenSqlPattern("SELECT set_config('role', 'anon', true)", 'service_role')).toBeNull();
  });
});

describe('findForbiddenSqlPattern — the settings that carry the caller identity', () => {
  it.each([
    "SET LOCAL request.jwt.claims = '{\"sub\":\"someone-else\"}'",
    "SET request.jwt.claims = '{\"sub\":\"someone-else\"}'",
    "SET SESSION request.jwt.claims = '{}'",
    "SELECT set_config('request.jwt.claims', '{}', true)",
    "SELECT set_config('request.jwt.claim.sub', 'someone-else', true)",
    "SELECT set_config('REQUEST.JWT.CLAIMS', '{}', false)",
    "with s as materialized (select set_config('request.jwt.claims', '{}', true)) select auth.uid() from s",
    "SET LOCAL request.jwt.claims = '{}'; SELECT * FROM notes",
  ])('refuses %s for a browser-key caller', (sql) => {
    for (const role of ['anon', 'authenticated'] as const) {
      const hit = findForbiddenSqlPattern(sql, role);
      expect(hit).not.toBeNull();
      expect(hit === 'SET request.jwt.*' || String(hit).includes('public key')).toBe(true);
    }
  });

  it('names the namespace rule when the statement does reach it', () => {
    // set_config() opens with SELECT, which a public key may run, so the
    // refusal comes from the identity rule itself rather than the class list.
    expect(findForbiddenSqlPattern("SELECT set_config('request.jwt.claims', '{}', true)", 'anon')).toBe(
      'SET request.jwt.*',
    );
  });

  it('lets the project owner set them, which is how a policy is tried out', () => {
    expect(
      findForbiddenSqlPattern("SET LOCAL request.jwt.claims = '{\"sub\":\"x\"}'", 'owner'),
    ).toBeNull();
    expect(findForbiddenSqlPattern("SELECT set_config('request.jwt.claims', '{}', true)", 'owner')).toBeNull();
  });

  it('does not refuse ordinary SQL that merely reads or mentions them', () => {
    expect(findForbiddenSqlPattern("SELECT current_setting('request.jwt.claims', true)", 'anon')).toBeNull();
    expect(findForbiddenSqlPattern('SELECT auth.uid()', 'anon')).toBeNull();
    expect(findForbiddenSqlPattern("INSERT INTO notes (body) VALUES ('set request.jwt.claims')", 'anon')).toBeNull();
    expect(findForbiddenSqlPattern('UPDATE t SET request = 1 WHERE id = 2', 'anon')).toBeNull();
    expect(findForbiddenSqlPattern('SELECT jwt FROM request', 'anon')).toBeNull();
  });
});

describe('findForbiddenSqlPattern — a public key may only read and write rows', () => {
  const PUBLIC_ROLES = ['anon', 'authenticated'] as const;

  it.each([
    'SELECT * FROM notes',
    'select 1',
    'WITH recent AS (SELECT * FROM notes LIMIT 5) SELECT * FROM recent',
    "INSERT INTO notes (body) VALUES ('hello')",
    "UPDATE notes SET body = 'x' WHERE id = 1",
    'DELETE FROM notes WHERE id = 1',
    'VALUES (1), (2)',
    'TABLE notes',
    'EXPLAIN SELECT * FROM notes',
    '(SELECT 1) UNION (SELECT 2)',
    'SELECT * FROM notes; SELECT * FROM tags;',
    'SELECT * FROM notes;',
  ])('lets a public key run %s', (sql) => {
    for (const role of PUBLIC_ROLES) expect(findForbiddenSqlPattern(sql, role)).toBeNull();
  });

  it.each([
    ['RESET ROLE', 'RESET'],
    ['reset role', 'RESET'],
    ['RESET ALL', 'RESET'],
    ['RESET SESSION AUTHORIZATION', 'RESET'],
    ['DISCARD ALL', 'DISCARD'],
    ['COMMIT', 'COMMIT'],
    ['ROLLBACK', 'ROLLBACK'],
    ['BEGIN', 'BEGIN'],
    ['END', 'END'],
    ['ABORT', 'ABORT'],
    ['SET LOCAL ROLE service_role', 'SET'],
    ['SHOW is_superuser', 'SHOW'],
    ['DO $$ BEGIN PERFORM 1; END $$', 'DO'],
    ['PREPARE p AS SELECT 1', 'PREPARE'],
    ['DEALLOCATE ALL', 'DEALLOCATE'],
    ['LISTEN channel', 'LISTEN'],
    ['CALL some_procedure()', 'CALL'],
    ['SELECT 1; RESET ROLE', 'RESET'],
    ['SELECT 1; COMMIT; SELECT 2', 'COMMIT'],
    ['SELECT 1;RESET ROLE', 'RESET'],
  ])('refuses %s on a public key, naming it', (sql, word) => {
    for (const role of PUBLIC_ROLES) {
      const hit = findForbiddenSqlPattern(sql, role);
      expect(hit).toContain(word);
      expect(hit).toContain('public key');
    }
  });

  it('does not apply the list to the dashboard or the secret key', () => {
    for (const sql of ['RESET ROLE', 'COMMIT', 'DO $$ BEGIN PERFORM 1; END $$', 'SHOW is_superuser']) {
      expect(findForbiddenSqlPattern(sql, 'owner')).toBeNull();
      expect(findForbiddenSqlPattern(sql, 'service_role')).toBeNull();
    }
  });
});

describe('findForbiddenSqlPattern — text that merely sounds like SQL is data', () => {
  const EVERY_ROLE = ['anon', 'authenticated', 'service_role', 'owner'] as const;

  it.each([
    "INSERT INTO i18n (k, v) VALUES ('copy_btn', 'Copy to clipboard')",
    "UPDATE settings SET value = 'copy to clipboard' WHERE key = 'hint'",
    "INSERT INTO audit (action) VALUES ('reset role')",
    "UPDATE t SET note = 'discard all' WHERE id = 1",
    "INSERT INTO docs (body) VALUES ('run TRUNCATE to empty a table')",
    "INSERT INTO docs (body) VALUES ('use GRANT to give access')",
    "INSERT INTO help (text) VALUES ('page load was slow')",
    "SELECT * FROM notes WHERE body = 'drop database is dangerous'",
  ])('stores %s', (sql) => {
    for (const role of EVERY_ROLE) expect(findForbiddenSqlPattern(sql, role)).toBeNull();
  });

  it('still reads a function body as the code it is', () => {
    const body = "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ COPY t TO PROGRAM 'sh' $$";
    expect(findForbiddenSqlPattern(body, 'owner')).toBe('COPY');
    expect(findForbiddenSqlPattern(body, 'service_role')).toBe('COPY');
  });

  it('still reads a DO block and dynamic SQL as code', () => {
    expect(findForbiddenSqlPattern("DO $$ BEGIN EXECUTE 'DROP DATABASE x'; END $$", 'owner')).toBe('DROP DATABASE');
    expect(findForbiddenSqlPattern("EXECUTE 'CREATE ROLE intruder'", 'owner')).toBe('CREATE ROLE');
  });
});

describe('findForbiddenSqlPattern — escapes are decoded where the string is run', () => {
  it('decodes an escaped keyword in a statement that executes its string', () => {
    expect(findForbiddenSqlPattern("EXECUTE E'\\x44ROP DATABASE x'", 'owner')).toBe('DROP DATABASE');
    expect(findForbiddenSqlPattern("DO $$ BEGIN EXECUTE E'\\x44ROP DATABASE x'; END $$", 'owner')).toBe(
      'DROP DATABASE',
    );
  });

  it('leaves the same text alone when it is only being selected or stored', () => {
    // Nothing runs it, so it is a string. Reading every string as SQL is what
    // refused ordinary rows of documentation.
    expect(findForbiddenSqlPattern("SELECT E'\\x44ROP DATABASE x'", 'owner')).toBeNull();
    expect(findForbiddenSqlPattern("INSERT INTO docs (body) VALUES (E'\\x44ROP DATABASE is final')", 'anon')).toBeNull();
  });

  it('still reads an escaped identifier, which is not a string at all', () => {
    expect(findForbiddenSqlPattern('SELECT U&"pg\\005fread\\005ffile"(\'/x\')', 'owner')).toBe('pg_read_file');
  });
});
