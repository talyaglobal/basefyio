/**
 * Denylist for the admin SQL console. Defense in depth only — the real
 * isolation is per-project databases + a non-privileged project role; this
 * blocks obviously dangerous statements (role/db/file/program/FDW ops) even if
 * comments try to smuggle them in. Extracted as a pure function so it is unit
 * tested independently of the service.
 */
export const FORBIDDEN_PATTERNS = [
  'DROP DATABASE',
  'DROP ROLE',
  'CREATE ROLE',
  'ALTER ROLE',
  'CREATE DATABASE',
  'COPY ',
  'pg_read_file',
  'pg_write_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'lo_import',
  'lo_export',
  'CREATE EXTENSION',
  'LOAD ',
  'SET ROLE',
  'SET SESSION AUTHORIZATION',
  'GRANT ',
  'REVOKE ',
  'CREATE USER',
  'ALTER USER',
  'DROP USER',
  'CREATE TABLESPACE',
  'ALTER SYSTEM',
  // Server-side file/program/foreign-data access.
  'PG_READ_SERVER_FILES',
  'PG_WRITE_SERVER_FILES',
  'PG_EXECUTE_SERVER_PROGRAM',
  'DBLINK',
  'CREATE FOREIGN',
  'CREATE SERVER',
  'CREATE PUBLICATION',
  'CREATE SUBSCRIPTION',
];

/**
 * Statements refused when the caller is not the project's owner.
 *
 * These are absent from the list above on purpose: the SQL editor is how a
 * project owner shapes their schema, so DDL has to work there. What must not
 * work is the same statement arriving on the public anon key. Postgres grants
 * should already stop it, but this file exists because grants are one layer
 * and a misgranted role would otherwise have no second one.
 *
 * The policy verbs matter most. An anon caller who can run ALTER POLICY or
 * ALTER TABLE ... DISABLE ROW LEVEL SECURITY takes the lid off the very
 * mechanism that bounds them, and CREATE FUNCTION lets them write a
 * SECURITY DEFINER function and call it back through rpc to run as the owner.
 */
export const OWNER_ONLY_PATTERNS = [
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'TRUNCATE',
  'CREATE SCHEMA',
  'DROP SCHEMA',
  'ALTER SCHEMA',
  'CREATE INDEX',
  'DROP INDEX',
  'CREATE VIEW',
  'ALTER VIEW',
  'DROP VIEW',
  'CREATE MATERIALIZED VIEW',
  'CREATE POLICY',
  'ALTER POLICY',
  'DROP POLICY',
  'ROW LEVEL SECURITY',
  'CREATE FUNCTION',
  'CREATE OR REPLACE FUNCTION',
  'DROP FUNCTION',
  'CREATE PROCEDURE',
  'CREATE TRIGGER',
  'DROP TRIGGER',
  'CREATE SEQUENCE',
  'ALTER SEQUENCE',
  'CREATE TYPE',
  'DROP TYPE',
  'SECURITY DEFINER',
];

/**
 * Who is running the statement.
 *
 * 'owner' is a dashboard team member in the SQL editor. The others are the
 * Postgres role an API-key call runs as: 'service_role' holds the project's
 * secret key and is treated as administrative, while 'anon' and
 * 'authenticated' arrive over a key that ships in a browser.
 */
export type SqlCallerRole = 'owner' | 'service_role' | 'authenticated' | 'anon';

/**
 * Returns the first forbidden pattern found in `query`, or null if the query is
 * allowed. Comments are stripped first so `/* DROP DATABASE *​/` can't smuggle a
 * banned token past the check.
 *
 * `role` decides whether the owner-only list applies as well; it defaults to
 * the stricter reading, so a caller that forgets to pass it gets the narrower
 * permission rather than the wider one.
 */
export function findForbiddenSqlPattern(
  query: string,
  role: SqlCallerRole = 'anon',
): string | null {
  const stripped = query
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\s+/g, ' ') // normalize whitespace
    .toUpperCase()
    .trim();

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (stripped.includes(pattern.toUpperCase())) {
      return pattern;
    }
  }

  if (role !== 'owner' && role !== 'service_role') {
    for (const pattern of OWNER_ONLY_PATTERNS) {
      if (stripped.includes(pattern.toUpperCase())) {
        return pattern;
      }
    }
  }

  return null;
}
