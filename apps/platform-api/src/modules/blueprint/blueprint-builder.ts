import {
  castValue,
  detectValueFormat,
  inferSchema,
  InferredType,
  sanitizeColumnName,
  transliterate,
  ValueFormat,
} from '../data-import/lib/type-inferrer';
import {
  AnalyzeBlueprintInput,
  ApplicationModel,
  AppRole,
  BlueprintColumn,
  BlueprintDomain,
  BlueprintForeignKey,
  BlueprintSourceSheet,
  BlueprintWarning,
  BusinessModel,
  DATA_MODEL_VERSION,
  DataModel,
  DataModelTable,
} from './blueprint.types';

type Format = Pick<ValueFormat, 'decimalSeparator' | 'dateOrder'>;

const DEFAULT_FORMAT: Format = { decimalSeparator: '.', dateOrder: 'DMY' };

/** Every generated table gets these columns, filled in by the database. */
export const SYSTEM_TIMESTAMP_COLUMNS = ['created_at', 'updated_at'] as const;

export const BLUEPRINT_TYPES: readonly InferredType[] = [
  'text',
  'integer',
  'bigint',
  'numeric',
  'boolean',
  'date',
  'timestamptz',
  'uuid',
  'jsonb',
];

/** Types a natural primary key may have. */
const KEY_TYPES = new Set<InferredType>(['integer', 'bigint', 'uuid', 'text']);
const INT_FAMILY = new Set<InferredType>(['integer', 'bigint']);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENT = 63;
const MAX_TABLES = 100;
const MAX_COLUMNS = 500;

/** Keyword → domain heuristics applied to sheet/table names. */
const DOMAIN_KEYWORDS: Record<Exclude<BlueprintDomain, 'generic'>, string[]> = {
  crm: ['customer', 'lead', 'contact', 'account', 'opportunity', 'deal', 'musteri'],
  inventory: ['product', 'stock', 'inventory', 'item', 'warehouse', 'sku', 'urun', 'stok'],
  orders: ['order', 'invoice', 'sale', 'payment', 'transaction', 'cart', 'siparis', 'fatura'],
  hr: ['employee', 'staff', 'payroll', 'department', 'leave', 'attendance', 'personel', 'calisan'],
};

const DOMAIN_KPIS: Record<BlueprintDomain, string[]> = {
  crm: ['Total customers', 'New leads', 'Open opportunities'],
  inventory: ['Total products', 'Low-stock items', 'Inventory value'],
  orders: ['Total orders', 'Revenue', 'Pending orders'],
  hr: ['Headcount', 'Open positions', 'Pending leave requests'],
  generic: ['Total records', 'Recently added'],
};

// ── Naming helpers ──────────────────────────────────────────────────────────

/** "Müşteriler" → "musteriler"; a name with no usable letters → "table_<n>". */
export function sanitizeTableName(raw: string, idx: number): string {
  if (!transliterate(raw ?? '').replace(/[^A-Za-z0-9]/g, '')) return `table_${idx + 1}`;
  return sanitizeColumnName(raw, idx);
}

/**
 * Candidate singular forms of a table name, used to match key and reference
 * columns: "customers" → customer, "categories" → category, "musteriler" →
 * musteri.
 */
export function singularForms(name: string): string[] {
  const out = new Set<string>([name]);
  if (name.length > 4 && name.endsWith('ies')) out.add(`${name.slice(0, -3)}y`);
  if (/(ses|xes|zes|ches|shes)$/.test(name)) out.add(name.slice(0, -2));
  if (name.length > 2 && name.endsWith('s') && !name.endsWith('ss')) out.add(name.slice(0, -1));
  if (name.length > 5 && /(ler|lar)$/.test(name)) out.add(name.slice(0, -3));
  return [...out];
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base.slice(0, MAX_IDENT);
  for (let i = 2; taken.has(name); i++) {
    const suffix = `_${i}`;
    name = `${base.slice(0, MAX_IDENT - suffix.length)}${suffix}`;
  }
  return name;
}

// ── Value helpers ───────────────────────────────────────────────────────────

/**
 * A cell as the database will store it, as a comparable string: null for an
 * empty cell, undefined when the value cannot be stored as `type` at all.
 */
function keyOf(raw: unknown, type: InferredType, format: Format): string | null | undefined {
  const r = castValue(raw, type, true, format);
  if (!r.ok) return undefined;
  if (r.value === null) return null;
  return String(r.value);
}

function checkKey(
  rows: unknown[][],
  col: BlueprintColumn,
  format: Format,
): { ok: true } | { ok: false; reason: string } {
  if (col.sourceIndex === undefined) return { ok: false, reason: 'no values in the file' };
  const seen = new Set<string>();
  let empty = 0;
  let repeated = 0;
  let invalid = 0;
  for (const row of rows) {
    const k = keyOf(row[col.sourceIndex], col.type, format);
    if (k === undefined) invalid++;
    else if (k === null) empty++;
    else if (seen.has(k)) repeated++;
    else seen.add(k);
  }
  if (empty) return { ok: false, reason: `${empty} empty value(s)` };
  if (repeated) return { ok: false, reason: `${repeated} repeated value(s)` };
  if (invalid) return { ok: false, reason: `${invalid} value(s) of the wrong type` };
  return { ok: true };
}

function castsAll(rows: unknown[][], idx: number | undefined, type: InferredType, format: Format): boolean {
  if (idx === undefined) return true;
  return rows.every((r) => castValue(r[idx], type, true, format).ok);
}

function typesCompatible(a: InferredType, b: InferredType): boolean {
  return a === b || (INT_FAMILY.has(a) && INT_FAMILY.has(b));
}

// ── Analysis ────────────────────────────────────────────────────────────────

const KEY_LIKE_NAME = /(^id$|_id$|^no$|_no$|number|code|kodu?$|numarasi)/;

/**
 * The inferrer reads a column holding only 0 and 1 as boolean. For an
 * identifier-like column (id, customer_id, order_no) that is a number.
 */
function fixKeyLikeBooleans(columns: BlueprintColumn[], rows: unknown[][]): void {
  for (const col of columns) {
    if (col.type !== 'boolean' || !KEY_LIKE_NAME.test(col.name) || col.sourceIndex === undefined) continue;
    const idx = col.sourceIndex;
    const numeric = rows.every((r) => {
      const v = r[idx];
      return v === null || v === undefined || (typeof v === 'string' ? /^\s*[01]?\s*$/.test(v) : v === 0 || v === 1);
    });
    if (numeric) col.type = 'integer';
  }
}

function renameColumn(table: DataModelTable, col: BlueprintColumn, base: string): void {
  const taken = new Set(table.columns.filter((c) => c !== col).map((c) => c.name));
  col.name = uniqueName(base, taken);
}

/**
 * created_at/updated_at are added to every generated table, and `id` is the
 * generated key unless the file's own `id` can serve as one. A source column
 * with one of those names keeps its values under a new name (with a warning)
 * instead of being dropped.
 */
function handleReservedColumns(
  table: DataModelTable,
  rows: unknown[][],
  warnings: BlueprintWarning[],
): void {
  for (const col of table.columns) {
    const original = col.name;
    if (!(SYSTEM_TIMESTAMP_COLUMNS as readonly string[]).includes(original)) continue;
    renameColumn(table, col, `source_${original}`);
    warnings.push({
      table: table.name,
      column: col.name,
      code: 'reserved_column_renamed',
      message:
        `"${col.originalName}" was renamed to "${col.name}": every generated table already has its own ` +
        `"${original}" column, filled in automatically. The values from the file are kept in "${col.name}".`,
    });
  }

  const idCol = table.columns.find((c) => c.name === 'id');
  if (!idCol) return;
  const check = KEY_TYPES.has(idCol.type)
    ? checkKey(rows, idCol, table.valueFormat ?? DEFAULT_FORMAT)
    : ({ ok: false, reason: `values of type ${idCol.type}` } as const);
  if (check.ok) {
    table.primaryKey = ['id'];
    idCol.nullable = false;
    return;
  }
  renameColumn(table, idCol, 'source_id');
  warnings.push({
    table: table.name,
    column: idCol.name,
    code: 'duplicate_key_values',
    message:
      `"${idCol.originalName}" cannot be the primary key (${check.reason}), so it was renamed to ` +
      `"${idCol.name}" and the table gets a generated "id" key instead.`,
  });
}

function keyNameCandidates(table: string): string[] {
  const names: string[] = [];
  const forms = singularForms(table);
  for (const suffix of ['id', 'code', 'no', 'number', 'key', 'kodu', 'kod', 'numarasi']) {
    for (const s of forms) names.push(`${s}_${suffix}`);
  }
  names.push('code', 'sku', 'uuid', 'kod', 'kodu');
  return names;
}

/** Use an identifying column of the file (customer_id, sku, …) as the primary key. */
function detectPrimaryKey(table: DataModelTable, rows: unknown[][]): void {
  if (table.primaryKey?.length || rows.length === 0) return;
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  for (const candidate of keyNameCandidates(table.name)) {
    const col = byName.get(candidate);
    if (!col || !KEY_TYPES.has(col.type)) continue;
    if (checkKey(rows, col, table.valueFormat ?? DEFAULT_FORMAT).ok) {
      table.primaryKey = [col.name];
      col.nullable = false;
      return;
    }
  }
}

function findReferencedTable(
  from: DataModelTable,
  col: BlueprintColumn,
  tables: DataModelTable[],
): { ref: DataModelTable; refCol: BlueprintColumn } | null {
  // Two passes: a column named exactly like another table's key wins over a
  // "<singular>_id" style match.
  for (const pass of [0, 1]) {
    for (const ref of tables) {
      if (ref === from || ref.primaryKey?.length !== 1) continue;
      const pk = ref.primaryKey[0];
      const refCol = ref.columns.find((c) => c.name === pk);
      if (!refCol) continue;
      const forms = singularForms(ref.name);
      const names =
        pass === 0
          ? pk === 'id'
            ? []
            : [pk]
          : forms.map((s) => (pk === 'id' ? `${s}_id` : `${s}_${pk}`));
      if (names.includes(col.name)) return { ref, refCol };
    }
  }
  return null;
}

/**
 * Turn columns that point at another sheet's key (orders.customer_id →
 * customers.customer_id) into foreign keys, but only when every value in the
 * file has a matching row — otherwise generation would fail, so the draft
 * gets a warning instead.
 */
export function detectForeignKeys(
  tables: DataModelTable[],
  rowsByTable: Map<string, unknown[][]>,
  warnings: BlueprintWarning[],
  include: (table: DataModelTable, col: BlueprintColumn) => boolean = () => true,
): void {
  for (const table of tables) {
    const fks: BlueprintForeignKey[] = [...(table.foreignKeys ?? [])];
    for (const col of table.columns) {
      if (table.primaryKey?.length === 1 && table.primaryKey[0] === col.name) continue;
      if (fks.some((f) => f.column === col.name) || !include(table, col)) continue;
      const match = findReferencedTable(table, col, tables);
      if (!match) continue;
      const { ref, refCol } = match;
      if (!typesCompatible(col.type, refCol.type)) {
        warnings.push({
          table: table.name,
          column: col.name,
          code: 'reference_type_mismatch',
          message:
            `"${col.name}" looks like a reference to ${ref.name}.${refCol.name}, but its values are ` +
            `${col.type} and the key is ${refCol.type}, so no foreign key was added.`,
        });
        continue;
      }
      const rows = rowsByTable.get(table.name) ?? [];
      const refRows = rowsByTable.get(ref.name) ?? [];
      if (rows.length && refRows.length && col.sourceIndex !== undefined && refCol.sourceIndex !== undefined) {
        const refFormat = ref.valueFormat ?? DEFAULT_FORMAT;
        const keys = new Set<string>();
        for (const r of refRows) {
          const k = keyOf(r[refCol.sourceIndex], refCol.type, refFormat);
          if (typeof k === 'string') keys.add(k);
        }
        let unmatched = 0;
        for (const r of rows) {
          const k = keyOf(r[col.sourceIndex], refCol.type, table.valueFormat ?? DEFAULT_FORMAT);
          if (k === null) continue;
          if (k === undefined || !keys.has(k)) unmatched++;
        }
        if (unmatched > 0) {
          warnings.push({
            table: table.name,
            column: col.name,
            code: 'reference_unmatched',
            message:
              `"${col.name}" looks like a reference to ${ref.name}.${refCol.name}, but ${unmatched} ` +
              `value(s) have no matching row there, so no foreign key was added.`,
          });
          continue;
        }
      }
      // integer → bigint so both sides hold the same range.
      if (col.type !== refCol.type && INT_FAMILY.has(col.type)) col.type = refCol.type;
      fks.push({ column: col.name, refTable: ref.name, refColumn: refCol.name });
    }
    if (fks.length) table.foreignKeys = fks;
  }
}

/**
 * Infer the data model from raw sheets (reusing the data-import inference)
 * and keep the rows each table was built from, so generation can load them.
 */
export function analyzeSheets(input: AnalyzeBlueprintInput): {
  dataModel: DataModel;
  sources: BlueprintSourceSheet[];
} {
  const exclude = new Set((input.excludeSheets ?? []).map((s) => String(s).toLowerCase()));
  const tables: DataModelTable[] = [];
  const sources: BlueprintSourceSheet[] = [];
  const warnings: BlueprintWarning[] = [];
  const rowsByTable = new Map<string, unknown[][]>();
  const usedNames = new Set<string>();

  (input.sheets ?? []).forEach((sheet, sheetIdx) => {
    if (!sheet || typeof sheet.name !== 'string' || !sheet.name.trim()) return;
    if (exclude.has(sheet.name.toLowerCase())) return;
    const headers = (Array.isArray(sheet.headers) ? sheet.headers : []).map((h) =>
      h === null || h === undefined ? '' : String(h),
    );
    const rows = (Array.isArray(sheet.rows) ? sheet.rows : []).filter((r): r is unknown[] =>
      Array.isArray(r),
    );
    if (headers.length === 0) return;

    const format = detectValueFormat(rows);
    const columns: BlueprintColumn[] = inferSchema(headers, rows, format)
      .map((c, i) => ({ ...c, sourceIndex: i }))
      // Spreadsheets often carry blank trailing columns: no header, no values.
      .filter((c) => headers[c.sourceIndex].trim() !== '' || c.sampleValues.length > 0);
    if (columns.length === 0) return;
    fixKeyLikeBooleans(columns, rows);

    const base = sanitizeTableName(sheet.name, sheetIdx);
    const name = uniqueName(base, usedNames);
    usedNames.add(name);
    if (name !== base) {
      warnings.push({
        table: name,
        code: 'table_renamed',
        message: `Sheet "${sheet.name}" was named "${name}" because another sheet already uses "${base}".`,
      });
    }

    const table: DataModelTable = {
      name,
      label: sheet.name,
      columns,
      valueFormat: format,
      rowCount: rows.length,
    };
    handleReservedColumns(table, rows, warnings);
    detectPrimaryKey(table, rows);

    const total = Number(sheet.totalRows);
    if (Number.isFinite(total) && total > rows.length) {
      table.rowCount = total;
      warnings.push({
        table: name,
        code: 'rows_truncated',
        message:
          `Only the first ${rows.length} of ${total} rows of "${sheet.name}" were included, so only ` +
          `those rows can be loaded. Use Import data on the project for the full file.`,
      });
    }

    tables.push(table);
    rowsByTable.set(name, rows);
    sources.push({ table: name, sheet: sheet.name, headers, rows });
  });

  detectForeignKeys(tables, rowsByTable, warnings);
  return { dataModel: { version: DATA_MODEL_VERSION, tables, warnings }, sources };
}

/** Build the inferred DataModel from raw sheets. */
export function buildDataModel(input: AnalyzeBlueprintInput): DataModel {
  return analyzeSheets(input).dataModel;
}

// ── Re-sync ─────────────────────────────────────────────────────────────────

const norm = (s: string) => (s ?? '').trim().toLowerCase();

/**
 * Fold a freshly analyzed file into the existing model so a re-sync keeps the
 * draft's edits: tables are matched by sheet name and columns by their header,
 * so renamed tables/columns, chosen keys, unique flags, references and types
 * survive. A kept type must still fit every new value, otherwise the newly
 * inferred type wins. Sheets and columns that left the file leave the model;
 * columns added in the editor stay.
 */
export function mergeDataModels(
  prev: DataModel,
  next: DataModel,
  nextRows: Map<string, unknown[][]>,
): { dataModel: DataModel; rowsByTable: Map<string, unknown[][]>; tableNames: Map<string, string> } {
  const prevTables = prev?.tables ?? [];
  // A model from before keys and references were tracked has no choices to
  // keep: its tables get the full key and reference detection.
  const legacy = !prev?.version;
  const prevByLabel = new Map(prevTables.map((t) => [norm(t.label), t]));
  const prevByName = new Map(prevTables.map((t) => [t.name, t]));
  const matchedPrev = new Set<string>();

  interface ColEntry {
    col: BlueprintColumn;
    /** the column's name in `next`; null for a column added in the editor. */
    nextName: string | null;
    added: boolean;
  }
  interface TableEntry {
    table: DataModelTable;
    nextName: string;
    kept: boolean;
    cols: ColEntry[];
    rows: unknown[][];
  }
  const entries: TableEntry[] = [];

  for (const nt of next.tables) {
    let pt = prevByLabel.get(norm(nt.label)) ?? prevByName.get(nt.name);
    if (pt && matchedPrev.has(pt.name)) pt = undefined;
    const rows = nextRows.get(nt.name) ?? [];
    const format = nt.valueFormat ?? DEFAULT_FORMAT;

    if (!pt) {
      const cols = nt.columns.map((c) => ({ col: { ...c }, nextName: c.name, added: true }));
      entries.push({
        table: { ...nt, columns: cols.map((e) => e.col) },
        nextName: nt.name,
        kept: false,
        cols,
        rows,
      });
      continue;
    }
    matchedPrev.add(pt.name);

    // Legacy columns carry no source index; all of them came from the file.
    const prevCols = new Map(
      pt.columns
        .filter((c) => legacy || c.sourceIndex !== undefined)
        .map((c) => [norm(c.originalName), c]),
    );
    const cols: ColEntry[] = [];
    for (const nc of nt.columns) {
      const pc = prevCols.get(norm(nc.originalName));
      if (!pc) {
        cols.push({ col: { ...nc }, nextName: nc.name, added: true });
        continue;
      }
      prevCols.delete(norm(nc.originalName));
      const type =
        pc.type !== nc.type && castsAll(rows, nc.sourceIndex, pc.type, format) ? pc.type : nc.type;
      cols.push({
        col: {
          ...nc,
          name: pc.name,
          type,
          nullable: pc.nullable || nc.nullable,
          ...(pc.unique ? { unique: true } : {}),
        },
        nextName: nc.name,
        added: false,
      });
    }
    for (const pc of pt.columns) {
      if (!legacy && pc.sourceIndex === undefined) {
        cols.push({ col: { ...pc }, nextName: null, added: false });
      }
    }
    // A legacy table was generated with its own uuid "id" key; a file column
    // called id must not be merged into it.
    if (legacy) {
      const names = new Set(cols.map((e) => e.col.name));
      for (const e of cols) {
        if (e.col.name !== 'id') continue;
        names.delete('id');
        e.col.name = uniqueName('source_id', names);
        names.add(e.col.name);
      }
    }

    // A new header may sanitize to a name an edited column already took; the
    // new column gives way.
    const taken = new Set(cols.filter((e) => !e.added).map((e) => e.col.name));
    for (const e of cols) {
      if (!e.added) continue;
      if (taken.has(e.col.name)) e.col.name = uniqueName(e.col.name, taken);
      taken.add(e.col.name);
    }

    const nextToMerged = new Map(cols.filter((e) => e.nextName !== null).map((e) => [e.nextName as string, e.col.name]));
    let pk: string[] | undefined;
    if (legacy) {
      const mapped = nt.primaryKey?.map((n) => nextToMerged.get(n) ?? n);
      // The file's id became source_id above, so it cannot be the key.
      pk = !nt.primaryKey?.includes('id') && mapped?.every((n) => taken.has(n)) ? mapped : undefined;
    } else if (pt.primaryKey?.length && pt.primaryKey.every((n) => taken.has(n))) {
      pk = [...pt.primaryKey];
    }
    for (const e of cols) if (pk?.includes(e.col.name)) e.col.nullable = false;

    entries.push({
      table: {
        name: pt.name,
        label: nt.label,
        columns: cols.map((e) => e.col),
        ...(pk?.length ? { primaryKey: pk } : {}),
        ...(pt.foreignKeys?.length
          ? { foreignKeys: pt.foreignKeys.filter((f) => taken.has(f.column)) }
          : {}),
        valueFormat: nt.valueFormat,
        rowCount: nt.rowCount,
      },
      nextName: nt.name,
      kept: true,
      cols,
      rows,
    });
  }

  // A new sheet must not reuse the name of a table kept from the old model.
  const tableTaken = new Set(entries.filter((e) => e.kept).map((e) => e.table.name));
  for (const e of entries) {
    if (e.kept) continue;
    if (tableTaken.has(e.table.name)) e.table.name = uniqueName(e.table.name, tableTaken);
    tableTaken.add(e.table.name);
  }

  const merged = entries.map((e) => e.table);
  const tableNames = new Map(entries.map((e) => [e.nextName, e.table.name]));
  const rowsByTable = new Map(entries.map((e) => [e.table.name, e.rows]));
  const columnNames = new Map(
    entries.map((e) => [
      e.table.name,
      new Map(e.cols.filter((c) => c.nextName !== null).map((c) => [c.nextName as string, c.col.name])),
    ]),
  );
  const newColumns = new Map(
    entries.map((e) => [e.table.name, new Set(e.cols.filter((c) => c.added).map((c) => c.col))]),
  );

  // Kept references must still point at a table and column of the model.
  for (const t of merged) {
    if (!t.foreignKeys) continue;
    t.foreignKeys = t.foreignKeys.filter((f) => {
      const ref = merged.find((r) => r.name === f.refTable);
      return !!ref && isReferenceable(ref, f.refColumn);
    });
    if (t.foreignKeys.length === 0) delete t.foreignKeys;
  }

  const warnings: BlueprintWarning[] = [];
  for (const w of next.warnings ?? []) {
    const table = tableNames.get(w.table);
    if (!table) continue;
    const column = w.column ? columnNames.get(table)?.get(w.column) ?? w.column : undefined;
    warnings.push({ ...w, table, ...(column ? { column } : {}) });
  }
  // Only columns that are new in this sync get references detected; for the
  // others the draft already shows what the owner chose.
  detectForeignKeys(merged, rowsByTable, warnings, (t, c) => legacy || !!newColumns.get(t.name)?.has(c));

  return {
    dataModel: { version: DATA_MODEL_VERSION, tables: merged, warnings },
    rowsByTable,
    tableNames,
  };
}


// ── Draft editing ───────────────────────────────────────────────────────────

/** Type of the column a foreign key may point at (the generated key is uuid). */
export function referencedColumnType(table: DataModelTable, column: string): InferredType | null {
  if (column === 'id' && !table.primaryKey?.length) return 'uuid';
  return table.columns.find((c) => c.name === column)?.type ?? null;
}

function isReferenceable(table: DataModelTable, column: string): boolean {
  if (!table.primaryKey?.length) {
    if (column === 'id') return true;
  } else if (table.primaryKey.length === 1 && table.primaryKey[0] === column) {
    return true;
  }
  return !!table.columns.find((c) => c.name === column)?.unique;
}

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * Validate a data model edited on the draft screen and return a clean copy
 * (unknown fields dropped). Analyzer warnings are carried over from `current`
 * for the tables and columns that still exist.
 */
export function validateDataModel(
  input: unknown,
  current: DataModel | null,
): { model: DataModel; errors: [] } | { model: null; errors: string[] } {
  const errors: string[] = [];
  const raw = input as { tables?: unknown } | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tables)) {
    return { model: null, errors: ['dataModel.tables must be an array'] };
  }
  if (raw.tables.length === 0) errors.push('The data model needs at least one table');
  if (raw.tables.length > MAX_TABLES) errors.push(`At most ${MAX_TABLES} tables are supported`);

  const tables: DataModelTable[] = [];
  const tableNames = new Set<string>();
  for (const [ti, t] of (raw.tables as any[]).slice(0, MAX_TABLES).entries()) {
    const name = str(t?.name, 200).trim();
    const where = name ? `table "${name}"` : `table #${ti + 1}`;
    if (!IDENT_RE.test(name) || name.length > MAX_IDENT) {
      errors.push(
        `Invalid name for ${where}: use letters, digits and underscores (at most ${MAX_IDENT}), starting with a letter or underscore`,
      );
    } else if (tableNames.has(name.toLowerCase())) {
      errors.push(`Two tables are named "${name}"`);
    }
    tableNames.add(name.toLowerCase());

    const rawCols: any[] = Array.isArray(t?.columns) ? t.columns : [];
    if (rawCols.length === 0) errors.push(`${where} needs at least one column`);
    if (rawCols.length > MAX_COLUMNS) errors.push(`${where} has more than ${MAX_COLUMNS} columns`);

    const primaryKey: string[] = Array.isArray(t?.primaryKey)
      ? t.primaryKey.filter((p: unknown): p is string => typeof p === 'string')
      : [];
    if (primaryKey.length > 4) errors.push(`The primary key of ${where} can have at most 4 columns`);

    const columns: BlueprintColumn[] = [];
    const colNames = new Set<string>();
    for (const c of rawCols.slice(0, MAX_COLUMNS)) {
      const cname = str(c?.name, 200).trim();
      if (!IDENT_RE.test(cname) || cname.length > MAX_IDENT) {
        errors.push(`Invalid column name "${cname}" in ${where}`);
        continue;
      }
      if (colNames.has(cname.toLowerCase())) {
        errors.push(`Two columns of ${where} are named "${cname}"`);
        continue;
      }
      colNames.add(cname.toLowerCase());
      if ((SYSTEM_TIMESTAMP_COLUMNS as readonly string[]).includes(cname.toLowerCase())) {
        errors.push(`"${cname}" in ${where} is reserved: every generated table has it, filled in automatically`);
      }
      if (cname.toLowerCase() === 'id' && !primaryKey.includes(cname)) {
        errors.push(
          `"${cname}" in ${where} is reserved for the generated key: make it the primary key or rename it`,
        );
      }
      const type = BLUEPRINT_TYPES.includes(c?.type) ? (c.type as InferredType) : null;
      if (!type) errors.push(`Unsupported type "${str(c?.type, 40)}" for column "${cname}" in ${where}`);
      const sourceIndex =
        Number.isInteger(c?.sourceIndex) && c.sourceIndex >= 0 ? (c.sourceIndex as number) : undefined;
      columns.push({
        name: cname,
        originalName: str(c?.originalName, 200) || cname,
        type: type ?? 'text',
        nullable: c?.nullable !== false && !primaryKey.includes(cname),
        sampleValues: (Array.isArray(c?.sampleValues) ? c.sampleValues : [])
          .slice(0, 5)
          .map((v: unknown) => str(v, 200)),
        ...(c?.unique === true ? { unique: true } : {}),
        ...(sourceIndex !== undefined ? { sourceIndex } : {}),
      });
    }
    for (const p of primaryKey) {
      if (!columns.some((c) => c.name === p)) errors.push(`Primary key column "${p}" does not exist in ${where}`);
    }

    const vf = t?.valueFormat;
    tables.push({
      name,
      label: str(t?.label, 200) || name,
      columns,
      ...(primaryKey.length ? { primaryKey } : {}),
      ...(Array.isArray(t?.foreignKeys) ? { foreignKeys: t.foreignKeys } : {}),
      valueFormat: {
        decimalSeparator: vf?.decimalSeparator === ',' ? ',' : '.',
        dateOrder: vf?.dateOrder === 'MDY' ? 'MDY' : 'DMY',
      },
      ...(Number.isInteger(t?.rowCount) && t.rowCount >= 0 ? { rowCount: t.rowCount } : {}),
    });
  }

  // References are checked once every table is known.
  for (const table of tables) {
    const rawFks: any[] = (table.foreignKeys as any[]) ?? [];
    const fks: BlueprintForeignKey[] = [];
    for (const fk of rawFks) {
      const column = str(fk?.column, 200);
      const refTable = str(fk?.refTable, 200);
      const refColumn = str(fk?.refColumn, 200);
      const col = table.columns.find((c) => c.name === column);
      const ref = tables.find((r) => r.name === refTable);
      if (!col) {
        errors.push(`Reference from "${table.name}": column "${column}" does not exist`);
        continue;
      }
      if (fks.some((f) => f.column === column)) {
        errors.push(`"${table.name}.${column}" has more than one reference`);
        continue;
      }
      if (!ref) {
        errors.push(`"${table.name}.${column}" references unknown table "${refTable}"`);
        continue;
      }
      if (!isReferenceable(ref, refColumn)) {
        errors.push(
          `"${table.name}.${column}" must reference the primary key or a unique column of "${refTable}"`,
        );
        continue;
      }
      const refType = referencedColumnType(ref, refColumn);
      if (!refType || !typesCompatible(col.type, refType)) {
        errors.push(
          `"${table.name}.${column}" (${col.type}) cannot reference "${refTable}.${refColumn}" (${refType ?? 'unknown'}): the types differ`,
        );
        continue;
      }
      fks.push({ column, refTable, refColumn });
    }
    if (fks.length) table.foreignKeys = fks;
    else delete table.foreignKeys;
  }

  if (errors.length) return { model: null, errors };

  const warnings = (current?.warnings ?? []).filter((w) => {
    const t = tables.find((x) => x.name === w.table);
    return !!t && (!w.column || t.columns.some((c) => c.name === w.column));
  });
  return {
    model: { version: DATA_MODEL_VERSION, tables, ...(warnings.length ? { warnings } : {}) },
    errors: [],
  };
}

// ── Business / application model ────────────────────────────────────────────

export function detectDomain(dataModel: DataModel): BlueprintDomain {
  const haystack = transliterate(
    dataModel.tables
      .flatMap((t) => [t.name, t.label, ...t.columns.map((c) => c.originalName)])
      .join(' '),
  ).toLowerCase();
  let best: BlueprintDomain = 'generic';
  let bestScore = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.reduce((n, k) => (haystack.includes(k) ? n + 1 : n), 0);
    if (score > bestScore) {
      bestScore = score;
      best = domain as BlueprintDomain;
    }
  }
  return best;
}

export function buildBusinessModel(dataModel: DataModel, domain: BlueprintDomain): BusinessModel {
  return {
    domain,
    actors: ['Admin', 'Member'],
    objects: dataModel.tables.map((t) => t.label),
    kpis: DOMAIN_KPIS[domain],
  };
}

export function buildApplicationModel(
  dataModel: DataModel,
  domain: BlueprintDomain,
  appName?: string,
): ApplicationModel {
  const tables = dataModel.tables.map((t) => t.name);
  const adminPerms: AppRole['permissions'] = {};
  const memberPerms: AppRole['permissions'] = {};
  for (const t of tables) {
    adminPerms[t] = ['read', 'create', 'update', 'delete'];
    memberPerms[t] = ['read'];
  }
  return {
    name: appName?.trim() || `${domain[0].toUpperCase()}${domain.slice(1)} App`,
    roles: [
      { name: 'Admin', permissions: adminPerms },
      { name: 'Member', permissions: memberPerms },
    ],
    navigation: dataModel.tables.map((t) => ({ label: t.label, table: t.name })),
    tables,
  };
}
