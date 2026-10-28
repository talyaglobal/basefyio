import { HttpException, HttpStatus } from '@nestjs/common';
import { PostgrestParseError } from './types';

/**
 * PostgREST's error contract.
 *
 * postgrest-js hands the JSON body of a non-2xx response to the caller as
 * `error`, verbatim, and application code branches on `error.code` — a
 * SQLSTATE for a database error, `PGRSTnnn` for one the API raised itself.
 * The HTTP status is PostgREST's mapping of the same code, which is what
 * `sqlstateStatus` reproduces.
 */
export interface PostgrestErrorBody {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

export class PostgrestHttpError extends HttpException {
  constructor(
    status: number,
    public readonly body: PostgrestErrorBody,
  ) {
    super(body, status);
    this.name = 'PostgrestHttpError';
  }
}

export function postgrestBody(
  code: string,
  message: string,
  details: string | null = null,
  hint: string | null = null,
): PostgrestErrorBody {
  return { code, message, details, hint };
}

/** Status PostgREST answers for a `PGRSTnnn` code of its own. */
export const PGRST_STATUS: Readonly<Record<string, number>> = {
  PGRST100: 400,
  PGRST102: 400,
  PGRST103: 416,
  PGRST105: 405,
  PGRST106: 406,
  PGRST107: 415,
  PGRST108: 400,
  PGRST111: 500,
  PGRST112: 500,
  PGRST116: 406,
  PGRST117: 405,
  PGRST118: 400,
  PGRST200: 400,
  PGRST201: 300,
  PGRST202: 404,
  PGRST203: 300,
  PGRST204: 400,
  PGRST205: 404,
  PGRST300: 500,
  PGRST301: 401,
  PGRST302: 401,
};

/**
 * HTTP status for a Postgres SQLSTATE, as PostgREST maps it.
 *
 * A permission failure is 401 for a caller who never authenticated and 403
 * for one who did, mirroring PostgREST's treatment of the anonymous role.
 */
export function sqlstateStatus(code: string | undefined, role?: string): number {
  if (!code) return 500;
  switch (code) {
    case '42P01':
    case '42883':
      return 404;
    case '23503':
    case '23505':
      return 409;
    case '42501':
      return role === 'anon' ? 401 : 403;
    case '25006':
      return 405;
    case 'P0001':
      return 400;
    case '42P17':
      return 500;
  }
  const cls = code.slice(0, 2);
  switch (cls) {
    case '08':
    case '53':
      return 503;
    case '54':
      return 413;
    case '0L':
    case '0P':
    case '28':
      return 403;
    case '09':
    case '25':
    case '2D':
    case '38':
    case '39':
    case '3B':
    case '40':
    case '55':
    case '57':
    case '58':
    case 'F0':
    case 'HV':
    case 'P0':
    case 'XX':
      return 500;
  }
  return 400;
}

/** True for the shape node-postgres gives a server error. */
export function isPgError(e: unknown): e is { code: string; message: string; detail?: string; hint?: string } {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as any).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((e as any).code) &&
    !(e instanceof HttpException)
  );
}

/**
 * A raw node-postgres error as PostgREST would report it. Anything that is
 * already an HttpException passes through, like `mapPgError`.
 */
export function pgToPostgrest(e: any, role?: string): unknown {
  if (e instanceof HttpException) return e;
  if (!isPgError(e)) return e;
  return new PostgrestHttpError(
    sqlstateStatus(e.code, role),
    postgrestBody(e.code, e.message, e.detail ?? null, e.hint ?? null),
  );
}

/** A parse failure (`PGRST100/200/204/205`) with PostgREST's status for it. */
export function parseErrorToPostgrest(err: PostgrestParseError): PostgrestHttpError {
  return new PostgrestHttpError(
    PGRST_STATUS[err.code] ?? HttpStatus.BAD_REQUEST,
    postgrestBody(err.code, err.message, err.details ?? null),
  );
}

export function notAcceptableObject(n: number): PostgrestHttpError {
  return new PostgrestHttpError(
    406,
    postgrestBody(
      'PGRST116',
      'JSON object requested, multiple (or no) rows returned',
      n === 0 ? 'The result contains 0 rows' : `${n} rows`,
    ),
  );
}
