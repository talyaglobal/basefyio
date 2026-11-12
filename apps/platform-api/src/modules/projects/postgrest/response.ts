import { COUNT_MODES, CountMode, PostgrestParseError, SelectItem } from './types';
import { UpsertResolution } from './write';

/**
 * Request preferences and response shaping for the REST data API: the
 * `Prefer` header, the `Range` header, `Content-Range`, CSV, and the column
 * list a write returns.
 */

export interface Preferences {
  return?: 'minimal' | 'representation' | 'headers-only';
  count?: CountMode;
  resolution?: UpsertResolution;
}

/**
 * Parse `Prefer: return=representation, count=exact, resolution=merge-duplicates`.
 *
 * Tokens are comma-separated (a header sent twice arrives joined the same
 * way); an unknown token or value is ignored, as RFC 7240 asks, so a client
 * sending a preference this API does not implement still gets a response.
 */
export function parsePrefer(header: string | string[] | undefined): Preferences {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const prefs: Preferences = {};
  for (const token of raw.split(',')) {
    const [name, value] = token.split(';')[0].split('=').map((s) => s?.trim().toLowerCase());
    if (!name || !value) continue;
    if (name === 'return' && (value === 'minimal' || value === 'representation' || value === 'headers-only')) {
      prefs.return = value;
    } else if (name === 'count' && COUNT_MODES.has(value)) {
      prefs.count = value as CountMode;
    } else if (name === 'resolution' && (value === 'merge-duplicates' || value === 'ignore-duplicates')) {
      prefs.resolution = value;
    }
  }
  return prefs;
}

/**
 * `Range: 0-24` (with `Range-Unit: items`) as an offset and a limit.
 *
 * Returns null when there is no usable header. An open-ended `10-` means "from
 * row 10", with the default page size.
 */
export function parseRangeHeader(
  header: string | undefined,
  unit: string | undefined,
): { offset: number; limit?: number } | null {
  if (!header) return null;
  if (unit && unit.trim().toLowerCase() !== 'items') return null;
  const m = header.trim().match(/^(?:items=)?(\d+)-(\d*)$/i);
  if (!m) {
    throw new PostgrestParseError(`Malformed Range header "${header}"; expected e.g. "0-24"`, undefined, 'PGRST103');
  }
  const from = Number(m[1]);
  if (m[2] === '') return { offset: from };
  const to = Number(m[2]);
  if (to < from) {
    throw new PostgrestParseError(`Range "${header}" ends before it starts`, undefined, 'PGRST103');
  }
  return { offset: from, limit: to - from + 1 };
}

/** `Content-Range: 0-24/3573`, `*` for an unknown total, `*\/0` for an empty page. */
export function contentRange(offset: number, returned: number, total: number | null): string {
  const size = total === null ? '*' : String(total);
  if (returned === 0) return `*/${size}`;
  return `${offset}-${offset + returned - 1}/${size}`;
}

/** Whether the client asked for CSV rather than JSON. */
export function wantsCsv(accept: string | undefined): boolean {
  if (!accept) return false;
  return accept
    .split(',')
    .map((s) => s.split(';')[0].trim().toLowerCase())
    .some((t) => t === 'text/csv');
}

/**
 * Rows as CSV (RFC 4180): a header line from the first row's keys, every value
 * quoted when it has to be. Nested values — embeds, JSON columns — are written
 * as JSON text; NULL is an empty field.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let text: string;
    if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object') text = JSON.stringify(value);
    else text = String(value);
    return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [keys.map((k) => cell(k)).join(',')];
  for (const row of rows) lines.push(keys.map((k) => cell(row[k])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * Apply `?select=` to the rows a write returned.
 *
 * A write returns whole rows (RETURNING *); `select` narrows them to the
 * columns asked for, renamed when aliased. Embeds, casts and JSON paths need
 * the read path and are refused here with a clear message rather than
 * silently ignored.
 */
export function projectRows(
  rows: Record<string, unknown>[],
  select: SelectItem[],
): Record<string, unknown>[] {
  if (select.some((item) => item.kind === 'star')) {
    if (select.length > 1) {
      throw new PostgrestParseError('On a write, select is either * or a list of columns');
    }
    return rows;
  }
  const columns = select.map((item) => {
    if (item.kind !== 'column' || item.cast || item.field.jsonPath.length) {
      throw new PostgrestParseError(
        'On a write, select can only name plain columns (optionally aliased); read the row back for embeds, casts or JSON paths',
      );
    }
    return { column: item.field.column, label: item.alias ?? item.field.column };
  });
  if (rows.length) {
    for (const { column } of columns) {
      if (!(column in rows[0])) {
        throw new PostgrestParseError(`Column "${column}" is not in the returned row`, undefined, 'PGRST204');
      }
    }
  }
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const { column, label } of columns) out[label] = row[column];
    return out;
  });
}
