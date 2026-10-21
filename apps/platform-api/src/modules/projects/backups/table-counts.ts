/**
 * Per-table row counts for a backup, and the comparison that decides whether a
 * restore reproduced them.
 *
 * At dump time the counts are taken inside the same snapshot pg_dump uses
 * (`pg_export_snapshot()` + `pg_dump --snapshot`), so they describe exactly the
 * rows the archive holds — not the live table a second later. The restore
 * drill then counts the rebuilt database with the same function and compares.
 */

/** Minimal slice of pg's client interface, so specs can pass a plain object. */
export interface CountingClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface TableRef {
  schema: string;
  table: string;
}

export interface TableCount extends TableRef {
  /** Null when the count timed out or the table was beyond `maxTables`. */
  rows: number | null;
}

export interface TableCountsFile {
  formatVersion: 1;
  /** The exported snapshot id pg_dump ran under, when one was used. */
  snapshot: string | null;
  countedAt: string;
  /** True when more tables existed than `maxTables`; the surplus has `rows: null`. */
  truncated: boolean;
  tables: TableCount[];
}

/** Path of the counts file inside a backup archive. */
export const TABLE_COUNTS_ENTRY = 'database/tables.json';

/** Ordinary and partitioned tables in user schemas; partitions themselves are counted through their parent. */
export const LIST_USER_TABLES_SQL = `
  select n.nspname as "schema", c.relname as "table"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and not c.relispartition
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\\_toast%'
  order by 1, 2
`;

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function listUserTables(client: CountingClient): Promise<TableRef[]> {
  const res = await client.query(LIST_USER_TABLES_SQL);
  return res.rows.map((r) => ({ schema: String(r.schema), table: String(r.table) }));
}

export interface CollectOptions {
  /** Count at most this many tables; the rest are listed with `rows: null`. */
  maxTables?: number;
  /** Per-table statement_timeout. A table that takes longer is recorded as unknown, not as a failure. */
  perTableTimeoutMs?: number;
  snapshot?: string | null;
  now?: () => Date;
}

/**
 * Count every user table. The caller must already be inside a transaction:
 * each count runs in its own savepoint so a timeout on one table rolls back
 * only that statement and leaves the transaction usable for the next.
 */
export async function collectTableCounts(
  client: CountingClient,
  opts: CollectOptions = {},
): Promise<TableCountsFile> {
  const maxTables = Math.max(0, opts.maxTables ?? 300);
  const timeoutMs = Math.max(1, opts.perTableTimeoutMs ?? 20_000);
  const tables = await listUserTables(client);

  const out: TableCount[] = [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (i >= maxTables) {
      out.push({ ...t, rows: null });
      continue;
    }
    await client.query('SAVEPOINT bf_count');
    try {
      // SET LOCAL lives inside the savepoint, so a rollback drops it too.
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
      const res = await client.query(
        `select count(*)::bigint as n from ${quoteIdent(t.schema)}.${quoteIdent(t.table)}`,
      );
      await client.query('RELEASE SAVEPOINT bf_count');
      out.push({ ...t, rows: Number(res.rows[0]?.n ?? 0) });
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT bf_count').catch(() => undefined);
      out.push({ ...t, rows: null });
    }
  }

  return {
    formatVersion: 1,
    snapshot: opts.snapshot ?? null,
    countedAt: (opts.now ?? (() => new Date()))().toISOString(),
    truncated: tables.length > maxTables,
    tables: out,
  };
}

export interface TableCountMismatch extends TableRef {
  expected: number;
  actual: number | null;
}

export interface TableCountComparison {
  /** Tables recorded at dump time that the restore does not have. */
  missingTables: string[];
  /** Tables whose recorded count is known and differs after the restore. */
  mismatches: TableCountMismatch[];
  /** How many tables had a known count on both sides and were compared. */
  compared: number;
}

const key = (t: TableRef) => `${t.schema}.${t.table}`;

/** Compare the counts recorded at dump time with those of a restored database. */
export function compareTableCounts(expected: TableCount[], actual: TableCount[]): TableCountComparison {
  const actualByKey = new Map(actual.map((t) => [key(t), t]));
  const missingTables: string[] = [];
  const mismatches: TableCountMismatch[] = [];
  let compared = 0;

  for (const exp of expected) {
    const act = actualByKey.get(key(exp));
    if (!act) {
      missingTables.push(key(exp));
      continue;
    }
    if (exp.rows == null || act.rows == null) continue;
    compared++;
    if (exp.rows !== act.rows) {
      mismatches.push({ schema: exp.schema, table: exp.table, expected: exp.rows, actual: act.rows });
    }
  }

  return { missingTables, mismatches, compared };
}
