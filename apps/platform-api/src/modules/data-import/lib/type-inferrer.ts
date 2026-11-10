/**
 * Heuristic Postgres type inference from a sample of raw cell values.
 *
 * Strategy: try each candidate type in order of specificity. The most-specific
 * type that successfully parses ALL non-null sampled values for a column wins.
 * Empty strings, null, and undefined are treated as nullable signals — they
 * don't constrain the type but do mark the column as nullable.
 *
 * Designed to be wrong only in a recoverable direction: when uncertain we
 * widen to `text`. The user can override on the wizard's preview step.
 *
 * Locale: files exported from Turkish (and most European) spreadsheets write
 * "1.234,56" for numbers and "31.12.1999" for dates. {@link ValueFormat}
 * carries the decimal separator and day/month order the file uses — detected
 * from the sample by {@link detectValueFormat}, overridable in the wizard — so
 * those values parse instead of landing in the bad-row report.
 *
 * Test seam: this module is pure (no IO, no Postgres) so it can be unit-tested
 * with synthetic samples without spinning up a database.
 */

export type InferredType =
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'uuid'
  | 'date'
  | 'timestamptz'
  | 'jsonb'
  | 'text';

export type DecimalSeparator = '.' | ',';
/** How to read a non-ISO date such as 01/02/2026. ISO (YYYY-MM-DD) is always accepted. */
export type DateOrder = 'DMY' | 'MDY';

export interface ValueFormat {
  decimalSeparator: DecimalSeparator;
  dateOrder: DateOrder;
  /**
   * Text columns only: an empty cell becomes NULL (true) or an empty string
   * (false). Every other type stores an empty cell as NULL.
   */
  emptyAsNull: boolean;
  /** Text columns only: strip leading/trailing whitespace. Other types are always trimmed to parse. */
  trimText: boolean;
}

export const DEFAULT_VALUE_FORMAT: ValueFormat = {
  decimalSeparator: '.',
  dateOrder: 'DMY',
  emptyAsNull: true,
  trimText: true,
};

export function resolveValueFormat(partial?: Partial<ValueFormat> | null): ValueFormat {
  return {
    decimalSeparator:
      partial?.decimalSeparator === ',' ? ',' : DEFAULT_VALUE_FORMAT.decimalSeparator,
    dateOrder: partial?.dateOrder === 'MDY' ? 'MDY' : DEFAULT_VALUE_FORMAT.dateOrder,
    emptyAsNull: partial?.emptyAsNull ?? DEFAULT_VALUE_FORMAT.emptyAsNull,
    trimText: partial?.trimText ?? DEFAULT_VALUE_FORMAT.trimText,
  };
}

export interface InferredColumn {
  /** Sanitized column name safe for use as a Postgres identifier. */
  name: string;
  /** Original header as it appeared in the source file. */
  originalName: string;
  type: InferredType;
  nullable: boolean;
  /** Up to 5 non-null sample values, stringified, for UI preview. */
  sampleValues: string[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** ISO timestamp; the zone may be Z, ±hh, ±hhmm or ±hh:mm (Postgres accepts all of them). */
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
/** dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy (or month first, per the date order). */
const LOCAL_DATE_RE = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/;
const LOCAL_TIMESTAMP_RE =
  /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const INTEGER_RE = /^-?\d{1,18}$/;
const BIGINT_RE = /^-?\d+$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
/** JS Number.MAX_SAFE_INTEGER is 2^53 − 1 (~9.0e15). Use 10^15 as a safe cap. */
const SAFE_INT_ABS_LIMIT = 1e15;

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '1', 'evet', 'dogru']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '0', 'hayir', 'yanlis']);

const TRANSLITERATION: Record<string, string> = {
  ş: 's', Ş: 'S', ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I',
  ö: 'o', Ö: 'O', ü: 'u', Ü: 'U', ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o',
  Ø: 'O', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', œ: 'oe', Œ: 'OE',
};

/**
 * Fold letters with diacritics to their ASCII base ("şehir" → "sehir",
 * "açıklama" → "aciklama"), so a Turkish header becomes a readable
 * identifier instead of losing its letters.
 */
export function transliterate(s: string): string {
  return s
    .replace(/[şŞçÇğĞıİöÖüÜßæÆøØđĐłŁœŒ]/g, (c) => TRANSLITERATION[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isNull(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t === '' || t.toLowerCase() === 'null';
  }
  return false;
}

function tryBoolean(v: string): boolean | null {
  const folded = transliterate(v.toLowerCase());
  if (TRUE_WORDS.has(folded)) return true;
  if (FALSE_WORDS.has(folded)) return false;
  return null;
}

/**
 * Bring a number written in the file's convention to Postgres form
 * ("1.234,56" with a comma separator → "1234.56"). Returns null when the text
 * is not a number in that convention.
 */
export function normalizeNumber(raw: string, sep: DecimalSeparator): string | null {
  // Thousands may also be grouped with (non-breaking) spaces: "1 234,56".
  let t = raw.replace(/[\s\u00a0\u202f]/g, '');
  if (t.startsWith('+')) t = t.slice(1);
  if (t === '' || t === '-') return null;
  if (sep === ',') {
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) || /^-?\d+(,\d+)?$/.test(t)) {
      return t.replace(/\./g, '').replace(',', '.');
    }
    return null;
  }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) || /^-?\d+(\.\d+)?$/.test(t)) {
    return t.replace(/,/g, '');
  }
  return null;
}

/** Native numbers (JSON, spreadsheets) always stringify with a dot. */
function numberSeparatorFor(raw: unknown, fileSep: DecimalSeparator): DecimalSeparator {
  return typeof raw === 'number' || typeof raw === 'bigint' ? '.' : fileSep;
}

function tryInteger(v: string, sep: DecimalSeparator): string | null {
  const n = normalizeNumber(v, sep);
  if (n === null || !INTEGER_RE.test(n)) return null;
  const num = Number(n);
  return Number.isFinite(num) && Math.abs(num) < SAFE_INT_ABS_LIMIT ? n : null;
}

function tryBigint(v: string, sep: DecimalSeparator): string | null {
  const n = normalizeNumber(v, sep);
  return n !== null && BIGINT_RE.test(n) ? n : null;
}

function tryNumeric(v: string, sep: DecimalSeparator): string | null {
  const n = normalizeNumber(v, sep);
  return n !== null && NUMERIC_RE.test(n) ? n : null;
}

function tryUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function pad(n: number | string, width = 2): string {
  return String(n).padStart(width, '0');
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Normalize a date to YYYY-MM-DD, or null. */
export function parseDateValue(v: string, order: DateOrder): string | null {
  const iso = ISO_DATE_RE.exec(v);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isRealDate(y, m, d) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }
  const local = LOCAL_DATE_RE.exec(v);
  if (!local) return null;
  const a = Number(local[1]);
  const b = Number(local[3]);
  const y = Number(local[4]);
  const [d, m] = order === 'MDY' ? [b, a] : [a, b];
  return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

function normalizeZone(zone: string | undefined): string {
  if (!zone) return '';
  if (zone.toUpperCase() === 'Z') return '+00';
  return zone;
}

/** Normalize a timestamp to "YYYY-MM-DD HH:MM:SS[.fff][zone]", or null. */
export function parseTimestampValue(v: string, order: DateOrder): string | null {
  const iso = ISO_TIMESTAMP_RE.exec(v);
  if (iso) {
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const [h, mi, s] = [Number(iso[4]), Number(iso[5]), Number(iso[6] ?? 0)];
    if (!isRealDate(y, mo, d) || h > 23 || mi > 59 || s > 60) return null;
    return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}:${pad(s)}${iso[7] ?? ''}${normalizeZone(iso[8])}`;
  }
  const local = LOCAL_TIMESTAMP_RE.exec(v);
  if (!local) return null;
  const a = Number(local[1]);
  const b = Number(local[3]);
  const y = Number(local[4]);
  const [d, mo] = order === 'MDY' ? [b, a] : [a, b];
  const [h, mi, s] = [Number(local[5]), Number(local[6]), Number(local[7] ?? 0)];
  if (!isRealDate(y, mo, d) || h > 23 || mi > 59 || s > 60) return null;
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}${local[8] ?? ''}${normalizeZone(local[9])}`;
}

function tryJsonb(v: string): boolean {
  // Heuristic: looks like an object/array literal and parses cleanly.
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Coerce a single raw value to string for inference. We avoid calling
 * String(v) on objects because we want JSON serialization there (e.g. nested
 * structures from XLSX with cellDates=true return Date objects).
 */
function coerce(raw: unknown): string | null {
  if (isNull(raw)) return null;
  if (raw instanceof Date) {
    // Normalize Excel date cells to ISO timestamp so the timestamp matcher
    // succeeds. SheetJS's cellDates option produces these.
    return raw.toISOString();
  }
  if (typeof raw === 'number' || typeof raw === 'bigint') {
    return raw.toString();
  }
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'string') return raw.trim();
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * Guess the decimal separator and day/month order from a sample of cells.
 * Only unambiguous values count as evidence: "12,5" or "1.234,56" say comma,
 * "12.5" or "1,234.56" say dot, while "1.234" could be either and says
 * nothing. A date whose first part is above 12 must be day-first, one whose
 * second part is above 12 must be month-first; dotted dates are day-first by
 * convention.
 */
export function detectValueFormat(rows: unknown[][]): Pick<ValueFormat, 'decimalSeparator' | 'dateOrder'> {
  let comma = 0;
  let dot = 0;
  let dmy = 0;
  let mdy = 0;
  let scanned = 0;
  for (const row of rows) {
    for (const cell of row) {
      if (typeof cell !== 'string') continue;
      const v = cell.trim();
      if (!v || v.length > 40) continue;
      if (++scanned > 50_000) break;
      if (/^[+-]?\d+,\d{1,2}$/.test(v) || /^[+-]?\d+,\d{4,}$/.test(v) || /^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(v) || /^[+-]?\d{1,3}(\.\d{3}){2,}$/.test(v)) {
        comma++;
        continue;
      }
      if (/^[+-]?\d+\.\d{1,2}$/.test(v) || /^[+-]?\d+\.\d{4,}$/.test(v) || /^[+-]?\d{1,3}(,\d{3})+\.\d+$/.test(v) || /^[+-]?\d{1,3}(,\d{3}){2,}$/.test(v)) {
        dot++;
        continue;
      }
      const date = /^(\d{1,2})([./-])(\d{1,2})\2\d{4}(?:[ T].*)?$/.exec(v);
      if (date) {
        const a = Number(date[1]);
        const b = Number(date[3]);
        if (a > 12 && b <= 12) dmy += 10;
        else if (b > 12 && a <= 12) mdy += 10;
        else if (date[2] === '.') dmy += 1;
      }
    }
  }
  return {
    decimalSeparator: comma > dot ? ',' : '.',
    dateOrder: mdy > dmy ? 'MDY' : 'DMY',
  };
}

/**
 * Sanitize a header into a safe Postgres column identifier.
 * Letters with diacritics are folded to ASCII first ("şehir" → "sehir").
 * Falls back to `column_<idx>` if the header is empty or all-punctuation.
 */
export function sanitizeColumnName(header: string, idx: number): string {
  const cleaned = transliterate(header)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1') // can't start with a digit
    .slice(0, 63); // Postgres truncates identifiers at 63 bytes
  return cleaned || `column_${idx + 1}`;
}

/**
 * De-duplicate sanitized column names by appending _1, _2, … when collisions
 * occur. Postgres rejects duplicate column names in CREATE TABLE.
 */
export function dedupeColumnNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const raw of names) {
    const base = raw;
    const used = seen.get(base) ?? 0;
    const name = used === 0 ? base : `${base}_${used}`;
    seen.set(base, used + 1);
    if (used > 0) seen.set(name, 1);
    out.push(name);
  }
  return out;
}

/**
 * Run inference over a column of sampled values and return the chosen type.
 *
 * If the sample is entirely null/empty, defaults to `text` and marks the
 * column nullable. Otherwise picks the most-specific type that holds for
 * every non-null sampled value.
 */
export function inferColumnType(
  values: unknown[],
  format: Pick<ValueFormat, 'decimalSeparator' | 'dateOrder'> = DEFAULT_VALUE_FORMAT,
): {
  type: InferredType;
  nullable: boolean;
  sampleValues: string[];
} {
  // Each value keeps the separator it must be read with: a native number (from
  // JSON) is always written with a dot, whatever the file's text convention.
  const nonNull: Array<{ v: string; sep: DecimalSeparator }> = [];
  let sawNull = false;
  for (const v of values) {
    const c = coerce(v);
    if (c === null) {
      sawNull = true;
      continue;
    }
    nonNull.push({ v: c, sep: numberSeparatorFor(v, format.decimalSeparator) });
  }

  const sampleValues = nonNull.slice(0, 5).map((x) => x.v);
  const nullable = sawNull || nonNull.length === 0;

  if (nonNull.length === 0) {
    return { type: 'text', nullable: true, sampleValues };
  }

  const order = format.dateOrder;
  // Try each candidate in order of specificity. We require ALL non-null values
  // to satisfy the candidate test for it to be chosen.
  const candidates: Array<{
    type: InferredType;
    test: (x: { v: string; sep: DecimalSeparator }) => boolean;
  }> = [
    { type: 'boolean', test: (x) => tryBoolean(x.v) !== null },
    { type: 'uuid', test: (x) => tryUuid(x.v) },
    { type: 'timestamptz', test: (x) => parseTimestampValue(x.v, order) !== null },
    { type: 'date', test: (x) => parseDateValue(x.v, order) !== null },
    { type: 'integer', test: (x) => tryInteger(x.v, x.sep) !== null },
    { type: 'bigint', test: (x) => tryBigint(x.v, x.sep) !== null },
    { type: 'numeric', test: (x) => tryNumeric(x.v, x.sep) !== null },
    { type: 'jsonb', test: (x) => tryJsonb(x.v) },
  ];

  for (const c of candidates) {
    if (nonNull.every(c.test)) {
      return { type: c.type, nullable, sampleValues };
    }
  }

  return { type: 'text', nullable, sampleValues };
}

/**
 * Build the full InferredColumn[] schema from a 2D sample. `headers` is the
 * original header row (may contain spaces, accents, duplicates); `rows` is
 * up to N raw sample rows aligned to the headers.
 */
export function inferSchema(
  headers: string[],
  rows: unknown[][],
  format: Pick<ValueFormat, 'decimalSeparator' | 'dateOrder'> = DEFAULT_VALUE_FORMAT,
): InferredColumn[] {
  const sanitizedRaw = headers.map((h, i) => sanitizeColumnName(h ?? '', i));
  const sanitized = dedupeColumnNames(sanitizedRaw);

  return headers.map((original, colIdx) => {
    const columnValues = rows.map((r) => r[colIdx]);
    const inf = inferColumnType(columnValues, format);
    return {
      name: sanitized[colIdx],
      originalName: original,
      type: inf.type,
      nullable: inf.nullable,
      sampleValues: inf.sampleValues,
    };
  });
}

/**
 * Cast a single raw value to a JS value compatible with the chosen Postgres
 * type. Returns `{ ok: true, value }` on success, `{ ok: false, reason }` on
 * failure — the caller decides whether to skip the row, NULL the cell, or
 * abort the import.
 *
 * Critical for validation/insert path: every cell flows through here before
 * being parameterized to pg, so a type mismatch becomes an explicit error
 * rather than a silent stringification.
 */
export function castValue(
  raw: unknown,
  type: InferredType,
  nullable: boolean,
  formatInput?: Partial<ValueFormat> | null,
):
  | { ok: true; value: unknown }
  | { ok: false; reason: string } {
  const format = resolveValueFormat(formatInput);
  const nullResult = ():
    | { ok: true; value: unknown }
    | { ok: false; reason: string } =>
    nullable ? { ok: true, value: null } : { ok: false, reason: 'NULL not allowed' };

  // Text keeps the user's choice about empty cells and surrounding spaces.
  if (type === 'text' && typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === 'null') return nullResult();
    if (trimmed === '') {
      if (format.emptyAsNull) return nullResult();
      return { ok: true, value: format.trimText ? '' : raw };
    }
    return { ok: true, value: format.trimText ? trimmed : raw };
  }

  if (isNull(raw)) return nullResult();

  const s = coerce(raw);
  if (s === null) return nullResult();
  const sep = numberSeparatorFor(raw, format.decimalSeparator);

  switch (type) {
    case 'boolean': {
      const b = tryBoolean(s);
      return b === null
        ? { ok: false, reason: `not a boolean: "${s}"` }
        : { ok: true, value: b };
    }
    case 'integer': {
      const n = tryInteger(s, sep);
      if (n === null) return { ok: false, reason: `not an integer: "${s}"` };
      return { ok: true, value: parseInt(n, 10) };
    }
    case 'bigint': {
      const n = tryBigint(s, sep);
      if (n === null) return { ok: false, reason: `not a bigint: "${s}"` };
      // pg driver accepts strings for bigint columns — safer than JS BigInt
      // here because the value may exceed Number.MAX_SAFE_INTEGER.
      return { ok: true, value: n };
    }
    case 'numeric': {
      const n = tryNumeric(s, sep);
      if (n === null) {
        return {
          ok: false,
          reason: `not a number: "${s}" (decimal separator "${sep}")`,
        };
      }
      // Sent as text so large or precise values are not rounded through a JS double.
      return { ok: true, value: n };
    }
    case 'uuid': {
      if (!tryUuid(s)) return { ok: false, reason: `not a uuid: "${s}"` };
      return { ok: true, value: s };
    }
    case 'date': {
      const d = parseDateValue(s, format.dateOrder);
      if (d === null) {
        return {
          ok: false,
          reason: `not a date: "${s}" (expected YYYY-MM-DD or ${format.dateOrder === 'MDY' ? 'MM/DD/YYYY' : 'DD.MM.YYYY'})`,
        };
      }
      return { ok: true, value: d };
    }
    case 'timestamptz': {
      const t = parseTimestampValue(s, format.dateOrder);
      if (t === null) return { ok: false, reason: `not a timestamp: "${s}"` };
      return { ok: true, value: t };
    }
    case 'jsonb': {
      try {
        JSON.parse(s);
      } catch (e: any) {
        return { ok: false, reason: `invalid JSON: ${e.message}` };
      }
      // Validated, then sent as text: node-pg would turn a parsed JS array
      // into a Postgres array literal ("{1,2}"), which jsonb rejects.
      return { ok: true, value: s };
    }
    case 'text':
    default:
      return { ok: true, value: s };
  }
}
