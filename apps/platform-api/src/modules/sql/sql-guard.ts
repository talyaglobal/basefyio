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
 * Returns the first forbidden pattern found in `query`, or null if the query is
 * allowed. Comments are stripped first so `/* DROP DATABASE *​/` can't smuggle a
 * banned token past the check.
 */
export function findForbiddenSqlPattern(query: string): string | null {
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
  return null;
}
