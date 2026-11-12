import { PostgrestParseError } from './types';

/**
 * INSERT and upsert statements for the REST data API.
 *
 * Kept apart from the service so the SQL can be tested without a database:
 * which conflict target an upsert uses, what it updates, and how a large batch
 * is split, are all decided here.
 */

/** Postgres binds at most this many parameters in one statement. */
export const PG_MAX_PARAMS = 65535;

export type UpsertResolution = 'merge-duplicates' | 'ignore-duplicates';

export interface InsertSpec {
  table: string;
  rows: Record<string, unknown>[];
  /** Quotes one column name, refusing one that cannot be a column. */
  quote: (name: string, context: string) => string;
  /**
   * Present for an upsert. `target` is the conflict target — the `on_conflict`
   * columns, else the primary key — or null when there is none, which only
   * `ignore-duplicates` can work with (any conflict is skipped).
   */
  upsert?: { resolution: UpsertResolution; target: string[] | null };
  /** Parameter ceiling per statement; tests lower it. */
  maxParams?: number;
}

/** The marker column an upsert adds to RETURNING so inserted and updated rows can be told apart. */
export const INSERTED_FLAG = '__bf_inserted';

/** Every element is a JSON object — what a row has to be. */
export function assertRows(body: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(body) ? body : [body];
  if (!rows.length) throw new PostgrestParseError('Empty body: send an object, or an array of objects');
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new PostgrestParseError('Every row must be a JSON object of column → value');
    }
  }
  return rows as Record<string, unknown>[];
}

/**
 * One statement per batch of rows, each under Postgres' parameter ceiling.
 *
 * A bulk insert binds rows × columns parameters, and past 65,535 the driver
 * fails with a protocol error the client saw as a bare 500 — with 7 columns
 * that is anything over 9,362 rows. The rows are split instead; the caller
 * runs every statement in one transaction, so the insert is still all or
 * nothing.
 *
 * Columns come from the first row, as they always have; a later row missing
 * one of them writes NULL there.
 */
export function buildInsertStatements(spec: InsertSpec): { sql: string; params: unknown[] }[] {
  const { table, rows, quote, upsert } = spec;
  const maxParams = spec.maxParams ?? PG_MAX_PARAMS;

  const keys = Object.keys(rows[0]);
  if (!keys.length) throw new PostgrestParseError('No columns provided');
  if (keys.length > maxParams) {
    throw new PostgrestParseError(`Too many columns in one row (${keys.length})`);
  }
  const cols = keys.map((k) => quote(k, 'insert column'));

  const tail = upsert ? conflictClause(keys, cols, quote, upsert) : '';
  // An upsert reports which rows it inserted: `xmax = 0` holds for a row this
  // statement created and not for one it updated, so realtime can publish an
  // INSERT or an UPDATE as appropriate. The flag is removed before responding.
  const returning = upsert ? `RETURNING *, (xmax = 0) AS "${INSERTED_FLAG}"` : 'RETURNING *';

  const rowsPerStatement = Math.max(1, Math.floor(maxParams / keys.length));
  const statements: { sql: string; params: unknown[] }[] = [];
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const batch = rows.slice(start, start + rowsPerStatement);
    const params: unknown[] = [];
    const groups = batch.map((row) => {
      const placeholders = keys.map((key) => {
        params.push(row[key] ?? null);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    statements.push({
      sql: `INSERT INTO "${table}" (${cols.join(', ')}) VALUES ${groups.join(', ')}${tail} ${returning}`,
      params,
    });
  }
  return statements;
}

/**
 * The ON CONFLICT clause.
 *
 * `merge-duplicates` updates every column the request sent except the
 * conflict target itself. When that leaves nothing to update — the row sent
 * was only its key — there is nothing to merge, and the clause is DO NOTHING
 * rather than the invalid `DO UPDATE SET` with an empty list.
 */
function conflictClause(
  keys: string[],
  cols: string[],
  quote: InsertSpec['quote'],
  upsert: NonNullable<InsertSpec['upsert']>,
): string {
  const target = upsert.target?.length
    ? ` (${upsert.target.map((c) => quote(c, 'on_conflict column')).join(', ')})`
    : '';

  if (upsert.resolution === 'ignore-duplicates') {
    return ` ON CONFLICT${target} DO NOTHING`;
  }
  if (!target) {
    throw new PostgrestParseError(
      'An upsert needs a conflict target: the table has no primary key, so name the unique column(s) with on_conflict=…',
    );
  }
  const targetSet = new Set(upsert.target);
  const updates = keys
    .map((k, i) => ({ k, col: cols[i] }))
    .filter(({ k }) => !targetSet.has(k))
    .map(({ col }) => `${col} = EXCLUDED.${col}`);
  if (!updates.length) return ` ON CONFLICT${target} DO NOTHING`;
  return ` ON CONFLICT${target} DO UPDATE SET ${updates.join(', ')}`;
}

/** The `on_conflict` query value as a column list. */
export function parseOnConflict(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new PostgrestParseError('Malformed on_conflict parameter');
  const cols = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of cols) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) {
      throw new PostgrestParseError(`Invalid on_conflict column: "${c}"`);
    }
  }
  return cols.length ? cols : undefined;
}
