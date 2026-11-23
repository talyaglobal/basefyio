import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { PostgrestParseError } from './postgrest/types';

/**
 * Map a raw PostgreSQL driver error to the appropriate HTTP exception for the
 * public data API. Pass-through for already-typed HttpExceptions; unknown codes
 * fall through to a 500. Extracted as a pure function so the code→status mapping
 * is unit tested independently of the service.
 */
export function mapPgError(e: any): unknown {
  if (e instanceof HttpException) return e;
  switch (e?.code) {
    case '42501': // insufficient_privilege — a missing grant, or an RLS policy that denied the row
      // Postgres words a missing grant "permission denied for table x" and a policy
      // "new row violates row-level security policy"; they need different fixes.
      return new ForbiddenException(
        /^permission denied/i.test(e.message ?? '')
          ? `${e.message}: the role has no privilege for this operation (a grant is missing)`
          : 'Permission denied by row-level security policy',
      );
    case '23505': // unique_violation
      return new ConflictException(e.detail || 'A record with these values already exists');
    case '23503': // foreign_key_violation
      return new ConflictException(e.detail || 'Foreign key constraint violation');
    case '23502': // not_null_violation
      return new BadRequestException(
        e.column ? `Column "${e.column}" cannot be null` : 'Not-null constraint violation',
      );
    case '23514': // check_violation
      return new BadRequestException(
        e.constraint ? `Check constraint "${e.constraint}" violated` : 'Check constraint violation',
      );
    case '22P02': // invalid_text_representation
    case '22007': // invalid_datetime_format
      return new BadRequestException(e.message ? `Invalid input value: ${e.message}` : 'Invalid input value');
    case 'P0001': // raise_exception — `raise exception '…'` in the project's own function
      // The text is written by the project owner for the caller (a validation
      // message, "not enough coins"), so it is shown; it used to be a bare
      // "Internal server error" that said nothing about what to fix.
      return new BadRequestException(e.message || 'The function raised an error');
    case '42703': // undefined_column
      return new BadRequestException('Unknown column in request');
    case '25006': // read_only_sql_transaction — a function called over GET/HEAD tried to write
      return new HttpException(
        'This function changes data, so it cannot be called with GET or HEAD; call it with POST',
        HttpStatus.METHOD_NOT_ALLOWED,
      );
    case '42P01': // undefined_table
      return new NotFoundException(
        'Table not found. Document (NoSQL) projects expose data at /rest/v1/collections/:name',
      );
    default:
      return e; // unknown → NestJS renders a 500
  }
}

/**
 * {@link mapPgError} for the REST data API, where a caller's bad input must
 * never surface as a 500 or carry an internal message.
 *
 * - a request-parse failure that escaped to here is a 400 with its PostgREST code;
 * - a Postgres "data exception" (class 22: numeric overflow, value too long,
 *   division by zero, bad datetime, ...) is about the value the caller sent, so
 *   it is a 400 that keeps Postgres's short description;
 * - any other statement Postgres rejects as malformed (class 42, 2x, 0A, 44) is
 *   a 400, and an integrity failure that has no dedicated mapping a 409, both with
 *   a fixed message that names no table, column, constraint or value;
 * - everything else (connection loss, internal errors) is left as is and renders
 *   as a generic 500.
 */
export function mapRestError(e: any): unknown {
  if (e instanceof PostgrestParseError) {
    return new BadRequestException({ message: e.message, details: e.details, code: e.code });
  }
  const mapped = mapPgError(e);
  if (mapped !== e) return mapped;
  const code: unknown = e?.code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return e;
  if (code.startsWith('22')) {
    const msg = typeof e.message === 'string' ? e.message.split('\n')[0].slice(0, 200) : '';
    return new BadRequestException(msg ? `Invalid input value: ${msg}` : 'Invalid input value');
  }
  if (code.startsWith('23')) return new ConflictException('The change violates a database constraint');
  if (/^(42|2B|0A|44)/.test(code)) return new BadRequestException('The request is not valid for this resource');
  return e;
}
