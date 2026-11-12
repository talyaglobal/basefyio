/**
 * Turning what someone typed into a data-editor cell into the value sent to
 * the API, checked against the column's type first so a wrong value is
 * caught in the browser with a clear message — not only after a round trip as
 * a raw Postgres error.
 */
import type { ColumnInfo } from '@/lib/types';
import { cellToEditText, formatCellValue } from '@/lib/cell-format';

export type CellKind = 'json' | 'array' | 'integer' | 'number' | 'boolean' | 'text';

/** Postgres keeps at most 63 bytes of a name and silently cuts the rest. */
export const MAX_IDENTIFIER_LENGTH = 63;

/** Why a table/column name would be refused, or null when it is fine. */
export function identifierProblem(name: string, label: 'Table' | 'Column'): string | null {
  if (!name) return `${label} name is required`;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return `${label} name may contain only letters, digits and underscores, and cannot start with a digit`;
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    return `${label} name is ${name.length} characters long; at most ${MAX_IDENTIFIER_LENGTH} are allowed`;
  }
  return null;
}

/**
 * Words Postgres reserves. A table or column may still be called this (the
 * dashboard quotes names), but every hand-written query must then quote it too.
 */
export const RESERVED_SQL_WORDS = new Set(
  (
    'all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create ' +
    'current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc ' +
    'distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral ' +
    'leading limit localtime localtimestamp not null offset on only or order placing primary references returning select ' +
    'session_user some symmetric system_user table then to trailing true union unique user using variadic when where window with'
  ).split(' '),
);

/** `type` is information_schema's data_type, as /columns returns it. */
export function cellKind(type: string | undefined): CellKind {
  const t = (type ?? '').toLowerCase();
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t === 'array') return 'array';
  if (t === 'integer' || t === 'bigint' || t === 'smallint') return 'integer';
  if (t === 'numeric' || t === 'real' || t === 'double precision' || t === 'decimal') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'text';
}

/** Structured columns get the multi-line editor. */
export function usesJsonEditor(col: ColumnInfo | undefined): boolean {
  const kind = cellKind(col?.type);
  return kind === 'json' || kind === 'array';
}

/** Text for an editor of this column: JSON pretty-printed, everything else one line. */
export function editorText(value: unknown, col: ColumnInfo | undefined): string {
  if (value === null || value === undefined) return '';
  if (usesJsonEditor(col) && typeof value === 'object') return JSON.stringify(value, null, 2);
  return cellToEditText(value);
}

export type ParsedCell = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Parse an entered value. An empty input is NULL (`value: null`); the caller
 * decides whether NULL is allowed.
 */
export function parseCellInput(text: string, col: ColumnInfo | undefined): ParsedCell {
  if (text === '') return { ok: true, value: null };
  const name = col?.name ? `"${col.name}"` : 'This column';
  const trimmed = text.trim();
  switch (cellKind(col?.type)) {
    case 'json':
      try {
        JSON.parse(trimmed);
        // Sent as text: Postgres parses it into json/jsonb. (An array sent as
        // a JS array would be turned into a Postgres array literal instead.)
        return { ok: true, value: trimmed };
      } catch (e: any) {
        return { ok: false, error: `${name} needs valid JSON (${e?.message ?? 'parse error'})` };
      }
    case 'array': {
      if (trimmed.startsWith('{')) return { ok: true, value: trimmed }; // Postgres array literal
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return { ok: true, value: parsed };
      } catch {
        /* fall through */
      }
      return { ok: false, error: `${name} needs a list, e.g. ["a", "b"] or {a,b}` };
    }
    case 'integer':
      return /^[-+]?\d+$/.test(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, error: `${name} needs a whole number` };
    case 'number':
      return trimmed !== '' && Number.isFinite(Number(trimmed))
        ? { ok: true, value: trimmed }
        : { ok: false, error: `${name} needs a number` };
    case 'boolean': {
      const v = trimmed.toLowerCase();
      if (['true', 't', 'yes', 'y', '1', 'on'].includes(v)) return { ok: true, value: true };
      if (['false', 'f', 'no', 'n', '0', 'off'].includes(v)) return { ok: true, value: false };
      return { ok: false, error: `${name} needs true or false` };
    }
    default:
      return { ok: true, value: text };
  }
}

/** True when a new row must give this column a value. */
export function isRequiredColumn(col: ColumnInfo): boolean {
  if (col.nullable || col.defaultValue) return false;
  // Identity columns report no default in information_schema; an integer
  // primary key is almost always one (or a serial), so it is left optional.
  if (col.isPrimary && cellKind(col.type) === 'integer') return false;
  return true;
}

/** "id = 3" — how a row is named in a confirmation. */
export function describeRow(
  row: Record<string, unknown>,
  keyColumns: string[],
  columns: ColumnInfo[],
): string {
  const cols = keyColumns.length ? keyColumns : columns.slice(0, 2).map((c) => c.name);
  const parts = cols.map((c) => {
    const v = row[c];
    const text = v === null || v === undefined ? 'NULL' : formatCellValue(v);
    return `${c} = ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
  });
  return parts.join(', ');
}
