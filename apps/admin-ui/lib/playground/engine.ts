// In-browser Postgres engine for the Playground, backed by PGlite (Postgres
// compiled to WASM). Runs entirely client-side: no backend, no auth, no data
// ever leaves the browser. "Reset" just drops + reseeds the same instance.
//
// The forbidden-operation guard mirrors the real platform-api SQL service
// (apps/platform-api/src/modules/sql/sql.service.ts) so the sandbox teaches the
// same rules the hosted API enforces — even though nothing here can escape WASM.

import type { PGlite } from '@electric-sql/pglite';
import { SEED_SQL } from './seed';

export interface PlaygroundField {
  name: string;
  dataTypeId: number;
}

export interface PlaygroundResultSet {
  fields: PlaygroundField[];
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface PlaygroundRunResult {
  ok: boolean;
  statusCode: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  fields: PlaygroundField[];
  rowCount: number | null;
  resultSets: PlaygroundResultSet[];
  error?: string;
}

// Mirrors FORBIDDEN_PATTERNS in the platform-api SQL service, plus the
// Playground-specific blocks from the product spec.
const FORBIDDEN_PATTERNS = [
  'DROP DATABASE',
  'CREATE DATABASE',
  'DROP ROLE',
  'CREATE ROLE',
  'ALTER ROLE',
  'CREATE USER',
  'ALTER USER',
  'DROP USER',
  'SET ROLE',
  'SET SESSION AUTHORIZATION',
  'GRANT ',
  'REVOKE ',
  'ALTER SYSTEM',
  'CREATE EXTENSION',
  'CREATE TABLESPACE',
  'COPY ',
  'LOAD ',
  'pg_read_file',
  'pg_write_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'lo_import',
  'lo_export',
];

export class ForbiddenSqlError extends Error {
  constructor(pattern: string) {
    super(`Forbidden SQL operation: ${pattern.trim()}`);
    this.name = 'ForbiddenSqlError';
  }
}

/** Strip comments + normalize so the guard can't be bypassed via /* ... *\/. */
function normalizeForGuard(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .trim();
}

export function guardQuery(query: string): void {
  const normalized = normalizeForGuard(query);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (normalized.includes(pattern)) {
      throw new ForbiddenSqlError(pattern);
    }
  }
}

let _dbPromise: Promise<PGlite> | null = null;

/** Lazily create and seed a single in-memory PGlite instance (client-only). */
export async function getPlaygroundDb(): Promise<PGlite> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      // Dynamic import keeps the WASM bundle off the server and out of the
      // initial JS payload until the Playground actually mounts.
      const { PGlite } = await import('@electric-sql/pglite');
      const db = await PGlite.create();
      await db.exec(SEED_SQL);
      return db;
    })();
  }
  return _dbPromise;
}

/** Drop everything and re-run the seed. */
export async function resetPlaygroundDb(): Promise<void> {
  const db = await getPlaygroundDb();
  await db.exec(SEED_SQL);
}

function mapFields(fields: { name: string; dataTypeID: number }[] | undefined): PlaygroundField[] {
  return (fields ?? []).map((f) => ({ name: f.name, dataTypeId: f.dataTypeID }));
}

/**
 * Execute SQL against the in-browser database. Returns an API-shaped result
 * (rows/fields/rowCount/duration/resultSets) plus an HTTP-style status code so
 * the Response panel can show what the real `POST /api/sql/execute` would return.
 */
export async function runPlaygroundSql(query: string): Promise<PlaygroundRunResult> {
  const started = performance.now();
  try {
    guardQuery(query);
    const db = await getPlaygroundDb();
    // exec() runs every statement in the script and returns one result each.
    const results = await db.exec(query);
    const durationMs = Math.round(performance.now() - started);

    const resultSets: PlaygroundResultSet[] = results.map((r) => ({
      fields: mapFields(r.fields),
      rows: (r.rows ?? []) as Record<string, unknown>[],
      rowCount: r.affectedRows ?? (r.rows ? r.rows.length : null),
    }));

    // Primary result: the last statement that returned columns, else the last.
    const primary =
      [...results].reverse().find((r) => r.fields && r.fields.length > 0) ??
      results[results.length - 1];

    return {
      ok: true,
      statusCode: 200,
      durationMs,
      rows: (primary?.rows ?? []) as Record<string, unknown>[],
      fields: mapFields(primary?.fields),
      rowCount: primary?.affectedRows ?? (primary?.rows ? primary.rows.length : null),
      resultSets,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      statusCode: err instanceof ForbiddenSqlError ? 403 : 400,
      durationMs,
      rows: [],
      fields: [],
      rowCount: null,
      resultSets: [],
      error: message,
    };
  }
}

export interface PlaygroundTable {
  name: string;
  columns: { name: string; type: string }[];
  rowCount: number;
}

/** Introspect the public schema for the Table Browser sidebar. */
export async function listPlaygroundTables(): Promise<PlaygroundTable[]> {
  const db = await getPlaygroundDb();
  const tablesRes = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );

  const tables: PlaygroundTable[] = [];
  for (const { table_name } of tablesRes.rows) {
    const colsRes = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table_name],
    );
    // Identifier is from information_schema (not user input) so interpolation
    // is safe here; PGlite has no parameterized identifiers.
    const countRes = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "${table_name}"`,
    );
    tables.push({
      name: table_name,
      columns: colsRes.rows.map((c) => ({ name: c.column_name, type: c.data_type })),
      rowCount: countRes.rows[0]?.count ?? 0,
    });
  }
  return tables;
}
