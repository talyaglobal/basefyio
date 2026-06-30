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
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const INTEGER_RE = /^-?\d{1,18}$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const TRUE_RE = /^(true|t|yes|y|1)$/i;
const FALSE_RE = /^(false|f|no|n|0)$/i;
/** JS Number.MAX_SAFE_INTEGER is 2^53 − 1 (~9.0e15). Use 10^15 as a safe cap. */
const SAFE_INT_ABS_LIMIT = 1e15;

function isNull(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t === '' || t.toLowerCase() === 'null';
  }
  return false;
}

function tryBoolean(v: string): boolean | null {
  if (TRUE_RE.test(v)) return true;
  if (FALSE_RE.test(v)) return false;
  return null;
}

function tryInteger(v: string): boolean {
  if (!INTEGER_RE.test(v)) return false;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < SAFE_INT_ABS_LIMIT;
}

function tryBigint(v: string): boolean {
  return /^-?\d+$/.test(v);
}

function tryNumeric(v: string): boolean {
  return NUMERIC_RE.test(v);
}

function tryUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function tryDate(v: string): boolean {
  return ISO_DATE_RE.test(v);
}

function tryTimestamp(v: string): boolean {
  return ISO_TIMESTAMP_RE.test(v);
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
 * Sanitize a header into a safe Postgres column identifier.
 * Falls back to `column_<idx>` if the header is empty or all-punctuation.
 */
export function sanitizeColumnName(header: string, idx: number): string {
  const cleaned = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1'); // can't start with a digit
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
export function inferColumnType(values: unknown[]): {
  type: InferredType;
  nullable: boolean;
  sampleValues: string[];
} {
  const nonNull: string[] = [];
  let sawNull = false;
  for (const v of values) {
    const c = coerce(v);
    if (c === null) {
      sawNull = true;
      continue;
    }
    nonNull.push(c);
  }

  const sampleValues = nonNull.slice(0, 5);
  const nullable = sawNull || nonNull.length === 0;

  if (nonNull.length === 0) {
    return { type: 'text', nullable: true, sampleValues };
  }

  // Try each candidate in order of specificity. We require ALL non-null values
  // to satisfy the candidate test for it to be chosen.
  const candidates: Array<{ type: InferredType; test: (v: string) => boolean }> = [
    { type: 'boolean', test: (v) => tryBoolean(v) !== null },
    { type: 'uuid', test: tryUuid },
    { type: 'timestamptz', test: tryTimestamp },
    { type: 'date', test: tryDate },
    { type: 'integer', test: tryInteger },
    { type: 'bigint', test: tryBigint },
    { type: 'numeric', test: tryNumeric },
    { type: 'jsonb', test: tryJsonb },
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
): InferredColumn[] {
  const sanitizedRaw = headers.map((h, i) => sanitizeColumnName(h ?? '', i));
  const sanitized = dedupeColumnNames(sanitizedRaw);

  return headers.map((original, colIdx) => {
    const columnValues = rows.map((r) => r[colIdx]);
    const inf = inferColumnType(columnValues);
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
):
  | { ok: true; value: unknown }
  | { ok: false; reason: string } {
  if (isNull(raw)) {
    if (nullable) return { ok: true, value: null };
    return { ok: false, reason: 'NULL not allowed' };
  }

  const s = coerce(raw);
  if (s === null) {
    return nullable
      ? { ok: true, value: null }
      : { ok: false, reason: 'NULL not allowed' };
  }

  switch (type) {
    case 'boolean': {
      const b = tryBoolean(s);
      return b === null
        ? { ok: false, reason: `not a boolean: "${s}"` }
        : { ok: true, value: b };
    }
    case 'integer': {
      if (!tryInteger(s)) return { ok: false, reason: `not an integer: "${s}"` };
      return { ok: true, value: parseInt(s, 10) };
    }
    case 'bigint': {
      if (!tryBigint(s)) return { ok: false, reason: `not a bigint: "${s}"` };
      // pg driver accepts strings for bigint columns — safer than JS BigInt
      // here because the value may exceed Number.MAX_SAFE_INTEGER.
      return { ok: true, value: s };
    }
    case 'numeric': {
      if (!tryNumeric(s)) return { ok: false, reason: `not a number: "${s}"` };
      return { ok: true, value: Number(s) };
    }
    case 'uuid': {
      if (!tryUuid(s)) return { ok: false, reason: `not a uuid: "${s}"` };
      return { ok: true, value: s };
    }
    case 'date': {
      if (!tryDate(s)) return { ok: false, reason: `not a date (YYYY-MM-DD): "${s}"` };
      return { ok: true, value: s };
    }
    case 'timestamptz': {
      if (!tryTimestamp(s))
        return { ok: false, reason: `not a timestamp: "${s}"` };
      return { ok: true, value: s };
    }
    case 'jsonb': {
      try {
        return { ok: true, value: JSON.parse(s) };
      } catch (e: any) {
        return { ok: false, reason: `invalid JSON: ${e.message}` };
      }
    }
    case 'text':
    default:
      return { ok: true, value: s };
  }
}
