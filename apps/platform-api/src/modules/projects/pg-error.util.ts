import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

/**
 * The response body for a mapped database error: the message a person reads,
 * plus Postgres' own SQLSTATE under `code` so a client can branch on it
 * (the global exception filter forwards `code`).
 */
function body(message: string, e: any): { message: string; code?: string } {
  return typeof e?.code === 'string' ? { message, code: e.code } : { message };
}

/** Postgres' message, followed by its DETAIL line when it has one. */
function withDetail(e: any, fallback: string): string {
  const message = typeof e?.message === 'string' && e.message ? e.message : fallback;
  return typeof e?.detail === 'string' && e.detail ? `${message}. ${e.detail}` : message;
}

/**
 * Map a raw PostgreSQL driver error to the appropriate HTTP exception for the
 * public data API. Pass-through for already-typed HttpExceptions; unknown codes
 * fall through to a 500. Extracted as a pure function so the code→status mapping
 * is unit tested independently of the service.
 *
 * The messages name what went wrong — the column, the constraint, the type the
 * value did not fit — because "Invalid input value" leaves the caller guessing.
 * They are Postgres' own words about the caller's own request; nothing about the
 * server is in them.
 */
export function mapPgError(e: any): unknown {
  if (e instanceof HttpException) return e;
  const code: string | undefined = typeof e?.code === 'string' ? e.code : undefined;
  switch (code) {
    case '42501': {
      // insufficient_privilege is raised for two different reasons, and the
      // fix for each is different: a policy that refused the row, or a role
      // that was never granted the table at all.
      const msg = typeof e?.message === 'string' ? e.message : '';
      if (/row-level security/i.test(msg)) {
        return new ForbiddenException(
          body(`Permission denied by row-level security policy: ${msg}`, e),
        );
      }
      return new ForbiddenException(
        body(
          msg
            ? `Permission denied: ${msg}. The database role behind this API key has no privilege on it — ` +
                'grant the privilege to that role, or call with a signed-in user or the service key.'
            : 'Permission denied',
          e,
        ),
      );
    }
    case '23505': // unique_violation
      return new ConflictException(body(e.detail || 'A record with these values already exists', e));
    case '23503': // foreign_key_violation
      return new ConflictException(body(e.detail || 'Foreign key constraint violation', e));
    case '23P01': // exclusion_violation
      return new ConflictException(body(withDetail(e, 'Exclusion constraint violation'), e));
    case '23502': // not_null_violation
      return new BadRequestException(
        body(e.column ? `Column "${e.column}" cannot be null` : 'Not-null constraint violation', e),
      );
    case '23514': // check_violation
      return new BadRequestException(
        body(
          e.constraint
            ? `Check constraint "${e.constraint}" violated${e.table ? ` on "${e.table}"` : ''}`
            : 'Check constraint violation',
          e,
        ),
      );
    case '42703': // undefined_column
      return new BadRequestException(body(withDetail(e, 'Unknown column in request'), e));
    case '42P01': // undefined_table
      return new NotFoundException(
        body('Table not found. Document (NoSQL) projects expose data at /rest/v1/collections/:name', e),
      );
    case '42883': // undefined_function — wrong argument names or types on rpc
    case '42725': // ambiguous_function
      return new BadRequestException(
        body(
          withDetail(e, 'No function matches the given name and argument types') +
            (typeof e?.hint === 'string' && e.hint ? ` ${e.hint}` : ''),
          e,
        ),
      );
    case 'P0001': // raise_exception — a function or trigger said no, in its own words
      return new BadRequestException(body(withDetail(e, 'The database raised an exception'), e));
    default:
      break;
  }

  // Class 22 is "data exception": a value that does not fit its column —
  // invalid text for a uuid, a number past its precision, a malformed date.
  // Always the caller's input, never the server's fault.
  if (code?.startsWith('22')) {
    return new BadRequestException(body(withDetail(e, 'Invalid input value'), e));
  }
  // Class 42 is "syntax error or access rule violation" — a cast to a type
  // that does not exist, a value of the wrong type for an argument. On this API
  // the statement is built from the request, so these are the request's. A
  // plain syntax error (42601) is the exception: the API wrote that SQL, so it
  // stays a 500 and is logged as the server's fault.
  if (code?.startsWith('42') && code !== '42601') {
    return new BadRequestException(body(withDetail(e, 'The request does not fit the schema'), e));
  }
  return e; // unknown → NestJS renders a 500
}
