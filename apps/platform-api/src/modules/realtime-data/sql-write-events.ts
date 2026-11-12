import type { DataChangeType } from './realtime-data.types';

/**
 * Recognises the write statements the SDK's query builder sends to
 * `/sql/execute`, so they reach realtime subscribers like REST writes do.
 *
 * Only one shape is accepted, the one the builder produces: a single
 * INSERT / UPDATE / DELETE on one table of the `public` schema, ending in
 * `RETURNING *`. The returned rows are the event payloads, so nothing is
 * inferred that the database did not report. Anything else — a script, a CTE,
 * a function call, a write without RETURNING — is not recognised and produces
 * no event, exactly as raw SQL never did.
 */
export interface SqlWrite {
  type: DataChangeType;
  table: string;
  /** INSERT … ON CONFLICT DO UPDATE: the rows returned may be new or updated. */
  upsert: boolean;
}

const ENTITY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT = `(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))`;
const SCHEMA = `(?:(?:"public"|public)\\s*\\.\\s*)?`;

const INSERT_RE = new RegExp(`^INSERT\\s+INTO\\s+${SCHEMA}${IDENT}\\s*\\(`, 'i');
const UPDATE_RE = new RegExp(`^UPDATE\\s+(?:ONLY\\s+)?${SCHEMA}${IDENT}(?:\\s+(?:AS\\s+)?[A-Za-z_][A-Za-z0-9_]*)?\\s+SET\\s`, 'i');
const DELETE_RE = new RegExp(`^DELETE\\s+FROM\\s+(?:ONLY\\s+)?${SCHEMA}${IDENT}(?:\\s|$)`, 'i');
const RETURNING_ALL_RE = /\bRETURNING\s+\*\s*;?\s*$/i;

/** The statement with comments, string literals, dollar quotes and quoted identifiers blanked out. */
function skeleton(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function parseSqlWrite(query: string): SqlWrite | null {
  if (typeof query !== 'string') return null;
  const text = query.replace(/^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*/, '').trim();
  const shape = skeleton(text).trim();
  // One statement only: a ';' anywhere but at the very end means a script.
  if (shape.replace(/;\s*$/, '').includes(';')) return null;
  if (!RETURNING_ALL_RE.test(shape)) return null;
  // Data-modifying CTEs and sub-statements are out of scope.
  if (/^WITH\b/i.test(shape)) return null;

  let type: DataChangeType;
  let m: RegExpExecArray | null;
  if ((m = INSERT_RE.exec(text))) type = 'INSERT';
  else if ((m = UPDATE_RE.exec(text))) type = 'UPDATE';
  else if ((m = DELETE_RE.exec(text))) type = 'DELETE';
  else return null;

  const table = m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2];
  if (!table || !ENTITY_RE.test(table)) return null;

  let upsert = false;
  if (type === 'INSERT' && /\bON\s+CONFLICT\b/i.test(shape)) {
    if (/\bDO\s+UPDATE\b/i.test(shape)) {
      // The statement does not say which rows were new; an upsert is reported
      // as an UPDATE of the row that now holds these values.
      type = 'UPDATE';
      upsert = true;
    }
    // ON CONFLICT DO NOTHING returns only the rows it inserted.
  }
  return { type, table, upsert };
}
