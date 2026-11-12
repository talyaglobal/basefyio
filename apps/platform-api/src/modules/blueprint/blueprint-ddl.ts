/**
 * SQL for Blueprint generation: CREATE TABLE with keys and unique
 * constraints, row-level security per access mode, foreign keys, and the
 * typed rows to load. Pure — no IO — so the exact statements can be previewed
 * on the draft and unit-tested.
 */
import { castValue, InferredType } from '../data-import/lib/type-inferrer';
import {
  BlueprintAccess,
  BlueprintForeignKey,
  BlueprintSourceSheet,
  DataModel,
  DataModelTable,
} from './blueprint.types';

export const PG_TYPE: Record<InferredType, string> = {
  boolean: 'BOOLEAN',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  numeric: 'NUMERIC',
  uuid: 'UUID',
  date: 'DATE',
  timestamptz: 'TIMESTAMPTZ',
  jsonb: 'JSONB',
  text: 'TEXT',
};

export function pgType(type: string): string {
  return PG_TYPE[type as InferredType] ?? 'TEXT';
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote an identifier the model validated; refuse anything else. */
export function qi(name: string): string {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(`Refusing unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

export function qualified(table: string): string {
  return `"public".${qi(table)}`;
}

/** Postgres' own default constraint names, so introspection finds them again. */
export const pkName = (table: string) => `${table}_pkey`;
export const uniqueName = (table: string, column: string) => `${table}_${column}_key`;
export const fkName = (table: string, column: string) => `${table}_${column}_fkey`;

/** True when the table uses the generated `id uuid` key. */
export function hasGeneratedKey(table: DataModelTable): boolean {
  return !table.primaryKey?.length;
}

export function buildCreateTable(table: DataModelTable): string {
  const defs: string[] = [];
  const generatedKey = hasGeneratedKey(table);
  if (generatedKey) defs.push(`"id" UUID NOT NULL DEFAULT gen_random_uuid()`);
  for (const c of table.columns) {
    defs.push(`${qi(c.name)} ${pgType(c.type)}${c.nullable ? '' : ' NOT NULL'}`);
  }
  defs.push(`"created_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);
  defs.push(`"updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);
  const pk = generatedKey ? ['id'] : (table.primaryKey as string[]);
  defs.push(`CONSTRAINT ${qi(pkName(table.name))} PRIMARY KEY (${pk.map(qi).join(', ')})`);
  for (const c of table.columns) {
    if (!c.unique || (pk.length === 1 && pk[0] === c.name)) continue;
    defs.push(`CONSTRAINT ${qi(uniqueName(table.name, c.name))} UNIQUE (${qi(c.name)})`);
  }
  return `CREATE TABLE ${qualified(table.name)} (\n  ${defs.join(',\n  ')}\n)`;
}

/**
 * Grants and row-level security. The service role always has full access;
 * signed-in users get what the chosen access mode allows. Anonymous callers
 * get nothing, whatever the mode.
 */
export function buildAccessStatements(table: string, access: BlueprintAccess): string[] {
  const t = qualified(table);
  const out = [
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO anon, authenticated, service_role`,
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY "service_role_all" ON ${t} FOR ALL TO service_role USING (true) WITH CHECK (true)`,
  ];
  if (access === 'authenticated_read') {
    out.push(`CREATE POLICY "authenticated_read" ON ${t} FOR SELECT TO authenticated USING (true)`);
  } else if (access === 'authenticated_write') {
    out.push(
      `CREATE POLICY "authenticated_all" ON ${t} FOR ALL TO authenticated USING (true) WITH CHECK (true)`,
    );
  }
  return out;
}

export function buildForeignKey(table: string, fk: BlueprintForeignKey): string {
  return (
    `ALTER TABLE ${qualified(table)} ADD CONSTRAINT ${qi(fkName(table, fk.column))} ` +
    `FOREIGN KEY (${qi(fk.column)}) REFERENCES ${qualified(fk.refTable)} (${qi(fk.refColumn)})`
  );
}

/** Every statement "Generate tables" runs for the model, in order (for the preview). */
export function buildGenerationSql(model: DataModel, access: BlueprintAccess): string[] {
  const out: string[] = [];
  for (const t of model.tables) {
    out.push(buildCreateTable(t), ...buildAccessStatements(t.name, access));
  }
  for (const t of model.tables) {
    for (const fk of t.foreignKeys ?? []) out.push(buildForeignKey(t.name, fk));
  }
  return out;
}

export function describeAccess(access: BlueprintAccess): string {
  switch (access) {
    case 'authenticated_read':
      return 'Row-level security is on. Signed-in users can read every row; only the service role can change data.';
    case 'authenticated_write':
      return 'Row-level security is on. Signed-in users can read and change every row.';
    default:
      return 'Row-level security is on with no policy for signed-in or anonymous users: only the service role (server code) and the dashboard can read or change these tables. Add policies to open them to your app.';
  }
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface PreparedRows {
  columns: string[];
  rows: unknown[][];
  skipped: number;
  /** Up to 5 reasons, "row 7: …" (row numbers as in the spreadsheet). */
  errors: string[];
}

const MAX_REPORTED_ERRORS = 5;

/** Find the stored source rows of a table (by sheet name, then table name). */
export function sourceFor(
  table: DataModelTable,
  sources: BlueprintSourceSheet[] | null | undefined,
): BlueprintSourceSheet | null {
  if (!sources?.length) return null;
  return sources.find((s) => s.sheet === table.label) ?? sources.find((s) => s.table === table.name) ?? null;
}

/**
 * Cast every source row to the table's column types (in the file's number
 * and date format). Rows that cannot be stored — a value of the wrong type,
 * an empty or repeated key, a repeated unique value — are skipped and
 * reported, so one bad row does not stop the load.
 */
export function prepareRows(table: DataModelTable, source: BlueprintSourceSheet): PreparedRows {
  const cols = table.columns.filter(
    (c) => c.sourceIndex !== undefined && c.sourceIndex < source.headers.length,
  );
  const format = table.valueFormat;
  const pk = table.primaryKey?.length ? table.primaryKey : null;
  const uniques = table.columns.filter((c) => c.unique).map((c) => c.name);
  const seenPk = new Set<string>();
  const seenUnique = new Map<string, Set<string>>(uniques.map((u) => [u, new Set<string>()]));
  const out: unknown[][] = [];
  const errors: string[] = [];
  let skipped = 0;

  const skip = (rowIdx: number, reason: string) => {
    skipped++;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(`row ${rowIdx + 2}: ${reason}`);
  };

  source.rows.forEach((raw, rowIdx) => {
    if (!Array.isArray(raw)) return;
    if (raw.every((v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === ''))) {
      return; // blank line, not data
    }
    const values: unknown[] = [];
    for (const c of cols) {
      const r = castValue(raw[c.sourceIndex as number], c.type, c.nullable, format);
      if (!r.ok) return skip(rowIdx, `column "${c.name}": ${r.reason}`);
      values.push(r.value);
    }
    const valueOf = (name: string) => values[cols.findIndex((c) => c.name === name)];
    if (pk) {
      const key = JSON.stringify(pk.map(valueOf));
      if (pk.some((p) => valueOf(p) === null || valueOf(p) === undefined)) {
        return skip(rowIdx, `empty primary key "${pk.join(', ')}"`);
      }
      if (seenPk.has(key)) return skip(rowIdx, `repeated primary key ${pk.map((p) => String(valueOf(p))).join(', ')}`);
      seenPk.add(key);
    }
    for (const u of uniques) {
      const v = valueOf(u);
      if (v === null || v === undefined) continue;
      const k = String(v);
      const seen = seenUnique.get(u) as Set<string>;
      if (seen.has(k)) return skip(rowIdx, `repeated value "${k}" in unique column "${u}"`);
      seen.add(k);
    }
    out.push(values);
  });

  return { columns: cols.map((c) => c.name), rows: out, skipped, errors };
}

/** Postgres allows 65535 bind parameters per statement. */
export function batchSize(columnCount: number): number {
  return Math.max(1, Math.min(500, Math.floor(60_000 / Math.max(1, columnCount))));
}

export function buildInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const ph = row.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    return `(${ph.join(', ')})`;
  });
  return {
    text: `INSERT INTO ${qualified(table)} (${columns.map(qi).join(', ')}) VALUES ${tuples.join(', ')}`,
    values,
  };
}
