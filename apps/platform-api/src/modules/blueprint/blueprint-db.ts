/**
 * The database side of Blueprint generation and migrations: read what the
 * project's tables really look like, create a table with its data, add
 * foreign keys. Every function takes a connected client so the caller decides
 * the transaction boundaries.
 */
import type { PoolClient } from 'pg';
import {
  BlueprintAccess,
  BlueprintForeignKey,
  BlueprintSourceSheet,
  DataModelTable,
} from './blueprint.types';
import {
  batchSize,
  buildAccessStatements,
  buildCreateTable,
  buildForeignKey,
  buildInsert,
  prepareRows,
  qualified,
} from './blueprint-ddl';

export interface LiveColumn {
  name: string;
  /** information_schema data_type, e.g. "integer", "timestamp with time zone". */
  dataType: string;
  nullable: boolean;
}

export interface LiveConstraint {
  name: string;
  type: 'p' | 'u' | 'f';
  columns: string[];
  refTable?: string;
  refColumns?: string[];
}

export interface LiveTable {
  name: string;
  columns: LiveColumn[];
  constraints: LiveConstraint[];
}

export type LiveSchema = Map<string, LiveTable>;

/** Columns and key/unique/foreign-key constraints of the given public tables. */
export async function introspectTables(client: PoolClient, names: string[]): Promise<LiveSchema> {
  const live: LiveSchema = new Map();
  if (names.length === 0) return live;
  const cols = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [names],
  );
  for (const r of cols.rows) {
    let t = live.get(r.table_name);
    if (!t) {
      t = { name: r.table_name, columns: [], constraints: [] };
      live.set(r.table_name, t);
    }
    t.columns.push({ name: r.column_name, dataType: r.data_type, nullable: r.is_nullable === 'YES' });
  }
  const cons = await client.query<{
    conname: string;
    contype: 'p' | 'u' | 'f';
    table_name: string;
    columns: string[];
    ref_table: string | null;
    ref_columns: string[] | null;
  }>(
    `SELECT c.conname, c.contype, rel.relname AS table_name,
            ARRAY(SELECT a.attname::text
                    FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS columns,
            frel.relname::text AS ref_table,
            CASE WHEN c.contype = 'f' THEN
              ARRAY(SELECT a.attname::text
                      FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                     ORDER BY k.ord)
            END AS ref_columns
       FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
       LEFT JOIN pg_class frel ON frel.oid = c.confrelid
      WHERE n.nspname = 'public' AND rel.relname = ANY($1::text[]) AND c.contype IN ('p', 'u', 'f')`,
    [names],
  );
  for (const r of cons.rows) {
    const t = live.get(r.table_name);
    if (!t) continue;
    t.constraints.push({
      name: r.conname,
      type: r.contype,
      columns: r.columns ?? [],
      ...(r.ref_table ? { refTable: r.ref_table, refColumns: r.ref_columns ?? [] } : {}),
    });
  }
  return live;
}

export interface LoadResult {
  rowsLoaded: number;
  rowsSkipped: number;
  errors: string[];
}

/**
 * Insert the source rows into a freshly created table. Batches go in whole;
 * if one fails anyway (a value Postgres still rejects), that batch is retried
 * row by row under a savepoint so only the offending rows are left out.
 * Must run inside a transaction.
 */
export async function loadRows(
  client: PoolClient,
  table: DataModelTable,
  source: BlueprintSourceSheet,
): Promise<LoadResult> {
  const prepared = prepareRows(table, source);
  const errors = [...prepared.errors];
  let skipped = prepared.skipped;
  let loaded = 0;
  if (prepared.columns.length === 0 || prepared.rows.length === 0) {
    return { rowsLoaded: 0, rowsSkipped: skipped, errors };
  }
  const size = batchSize(prepared.columns.length);
  for (let i = 0; i < prepared.rows.length; i += size) {
    const batch = prepared.rows.slice(i, i + size);
    await client.query('SAVEPOINT bp_batch');
    try {
      const { text, values } = buildInsert(table.name, prepared.columns, batch);
      await client.query(text, values);
      await client.query('RELEASE SAVEPOINT bp_batch');
      loaded += batch.length;
      continue;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT bp_batch');
    }
    for (const row of batch) {
      try {
        const { text, values } = buildInsert(table.name, prepared.columns, [row]);
        await client.query(text, values);
        await client.query('RELEASE SAVEPOINT bp_batch');
        await client.query('SAVEPOINT bp_batch');
        loaded++;
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT bp_batch');
        skipped++;
        if (errors.length < 5) errors.push(String(err?.message ?? err).slice(0, 200));
      }
    }
    await client.query('RELEASE SAVEPOINT bp_batch');
  }
  return { rowsLoaded: loaded, rowsSkipped: skipped, errors };
}

/**
 * CREATE TABLE + grants + row-level security (+ the data). Must run inside a
 * transaction so a failure leaves no half-built table behind.
 */
export async function createTable(
  client: PoolClient,
  table: DataModelTable,
  access: BlueprintAccess,
  source: BlueprintSourceSheet | null,
): Promise<LoadResult | null> {
  await client.query(buildCreateTable(table));
  // Rows go in before RLS is enabled; the owner bypasses RLS either way.
  const load = source ? await loadRows(client, table, source) : null;
  for (const sql of buildAccessStatements(table.name, access)) await client.query(sql);
  return load;
}

/**
 * Load the source rows into a table that already exists — only when it is
 * still empty (so nothing is ever duplicated) and already has every column
 * the rows need (otherwise the pending schema changes come first). Must run
 * inside a transaction.
 */
export async function loadIntoExistingTable(
  client: PoolClient,
  table: DataModelTable,
  source: BlueprintSourceSheet,
): Promise<LoadResult | { skippedReason: string }> {
  const { rows } = await client.query<{ has_rows: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${qualified(table.name)}) AS has_rows`,
  );
  if (rows[0]?.has_rows) return { skippedReason: 'the table already has rows' };
  const live = (await introspectTables(client, [table.name])).get(table.name);
  const liveCols = new Set((live?.columns ?? []).map((c) => c.name));
  const missing = table.columns
    .filter((c) => c.sourceIndex !== undefined && !liveCols.has(c.name))
    .map((c) => c.name);
  if (missing.length) {
    return {
      skippedReason: `apply the pending schema changes first (missing column(s): ${missing.join(', ')})`,
    };
  }
  return loadRows(client, table, source);
}

/**
 * Add one foreign key under a savepoint; a failure (rows without a match, a
 * missing referenced table) is reported instead of undoing the generation.
 */
export async function addForeignKey(
  client: PoolClient,
  table: string,
  fk: BlueprintForeignKey,
): Promise<{ created: boolean; reason?: string }> {
  await client.query('SAVEPOINT bp_fk');
  try {
    await client.query(buildForeignKey(table, fk));
    await client.query('RELEASE SAVEPOINT bp_fk');
    return { created: true };
  } catch (err: any) {
    await client.query('ROLLBACK TO SAVEPOINT bp_fk');
    return { created: false, reason: String(err?.message ?? err).slice(0, 300) };
  }
}
