/**
 * Reading rows from the source database without losing anything, and without
 * mistaking a failed read for an empty table.
 *
 * Pure functions, so the rules are testable without a database.
 */

/** The source column description the importer already carries. */
export interface CopyColumn {
  column_name: string;
  data_type: string;
}

/**
 * Types the Postgres driver turns into JavaScript objects: a `timestamptz`
 * becomes a `Date` (milliseconds, so the microseconds are gone), a `bytea` a
 * `Buffer`, an `interval` an object. The copy then stringified those, which
 * either truncated the value or sent something Postgres refuses.
 *
 * They are read as text instead, which keeps the exact value, and written back
 * as text, which Postgres parses into the column's own type.
 */
const READ_AS_TEXT = [
  'timestamp with time zone',
  'timestamptz',
  'timestamp without time zone',
  'timestamp',
  'date',
  'time with time zone',
  'timetz',
  'time without time zone',
  'time',
  'interval',
  'bytea',
];

export function readsAsText(dataType: string | undefined): boolean {
  return READ_AS_TEXT.includes((dataType ?? '').trim().toLowerCase());
}

/** `"a", "b"::text AS "b"` — the column list for the source SELECT. */
export function sourceSelectList(columns: CopyColumn[]): string {
  return columns
    .map((c) => {
      const name = c.column_name.replace(/[^a-zA-Z0-9_]/g, '');
      return readsAsText(c.data_type) ? `"${name}"::text AS "${name}"` : `"${name}"`;
    })
    .join(', ');
}

/**
 * Errors that go away by themselves: the server (or its pooler) is out of
 * connection slots, is starting or shutting down, or dropped the connection.
 * Anything else — a missing table, a permission, a syntax error — is a real
 * answer and retrying it only delays it.
 */
export function isTransientSourceError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code && ['53300', '53400', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08006', '40001'].includes(err.code)) {
    return true;
  }
  return /remaining connection slots|too many clients|max(?:imum)? clients|no more connections|connection (?:terminated|reset|refused)|ECONNRESET|ETIMEDOUT|EPIPE|timeout exceeded when trying to connect/i.test(
    err.message ?? '',
  );
}

export interface BackoffOptions {
  /** Attempts after the first one. */
  retries?: number;
  /** Delay before the first retry; doubled each time. */
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** What counts as worth retrying; defaults to a transient source-database error. */
  isRetryable?: (err: any) => boolean;
}

/**
 * Run `fn`, and run it again after a growing pause while it fails with a
 * transient error. A non-transient error, or the last failed attempt, is
 * thrown unchanged.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const retries = options.retries ?? 4;
  const baseMs = options.baseMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt >= retries || !(options.isRetryable ?? isTransientSourceError)(err)) throw err;
      const delay = baseMs * 2 ** attempt;
      options.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}
