import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

/**
 * Turning a Postgres error raised by the user's own statement into an answer
 * they can act on.
 *
 * The dashboard's database routes (indexes, triggers, functions, tables, rows)
 * used to let driver errors escape, and the global filter renders anything that
 * is not an HttpException as a bare 500 "Internal server error". A typo in a
 * column name or in a function body is not a server fault: Postgres already
 * says exactly what is wrong, and where. This keeps that message and returns it
 * with a 4xx status.
 *
 * Only errors that carry a SQLSTATE are translated. Anything else — a refused
 * connection, a bug of ours — is returned untouched so it still surfaces as a
 * 500 and is logged as one.
 */

interface PgLikeError {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
  position?: string | number;
  column?: string;
  table?: string;
  constraint?: string;
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

export function isPgError(err: unknown): err is PgLikeError {
  if (!err || typeof err !== 'object') return false;
  const code = (err as PgLikeError).code;
  return typeof code === 'string' && SQLSTATE_RE.test(code);
}

/** 1-based line and column of a character offset (Postgres positions are 1-based). */
export function lineAndColumn(sql: string, position: number): { line: number; column: number } {
  const upto = sql.slice(0, Math.max(0, position - 1));
  const lines = upto.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * The readable form of a Postgres error: its message, then detail, hint and —
 * when the statement text is known — the line and column it points at.
 */
export function describePgError(err: PgLikeError, sql?: string): string {
  let text = (err.message || 'Database error').trim();
  const pos = err.position != null ? Number(err.position) : NaN;
  if (sql && Number.isFinite(pos) && pos > 0) {
    const { line, column } = lineAndColumn(sql, pos);
    text += ` (line ${line}, column ${column})`;
  }
  if (err.detail) text += `. ${err.detail.trim()}`;
  if (err.hint) text += ` Hint: ${err.hint.trim()}`;
  return text;
}

/**
 * Map an error from a dashboard database route to the HTTP error the caller
 * should see. `prefix` names the action ("Failed to create index") and is put
 * in front of Postgres' own words.
 */
export function toUserFacingPgError(
  err: unknown,
  opts: { sql?: string; prefix?: string } = {},
): unknown {
  if (err instanceof HttpException) return err;
  if (!isPgError(err)) return err;

  const described = describePgError(err, opts.sql);
  const message = opts.prefix ? `${opts.prefix}: ${described}` : described;
  const code = err.code as string;
  const klass = code.slice(0, 2);

  switch (code) {
    case '42501': // insufficient_privilege
      return new ForbiddenException(message);
    case '42P01': // undefined_table
      return new NotFoundException(message);
    case '23505': // unique_violation
    case '42P07': // duplicate_table
    case '42710': // duplicate_object
    case '42723': // duplicate_function
    case '42P06': // duplicate_schema
    case '42701': // duplicate_column
    case '42P04': // duplicate_database
    case '55006': // object_in_use
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new ConflictException(message);
    default:
      break;
  }

  // Classes that describe the statement or the data rather than the server:
  // data exceptions, integrity violations, syntax/access rules, unsupported
  // features, cardinality, transaction state, invalid schema/catalog names,
  // WITH CHECK OPTION, program limits, objects not in the right state, a
  // cancelled statement and anything a PL/pgSQL RAISE produced.
  const userClasses = new Set(['0A', '21', '22', '23', '25', '2B', '2F', '3B', '3D', '3F', '42', '44', '54', '55', 'P0']);
  if (userClasses.has(klass) || code === '57014') {
    return new BadRequestException(message);
  }
  return err;
}
