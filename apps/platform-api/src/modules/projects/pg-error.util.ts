import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

/**
 * Map a raw PostgreSQL driver error to the appropriate HTTP exception for the
 * public data API. Pass-through for already-typed HttpExceptions; unknown codes
 * fall through to a 500. Extracted as a pure function so the code→status mapping
 * is unit tested independently of the service.
 */
export function mapPgError(e: any): unknown {
  if (e instanceof HttpException) return e;
  switch (e?.code) {
    case '42501': // insufficient_privilege — RLS policy denied the operation
      return new ForbiddenException('Permission denied by row-level security policy');
    case '23505': // unique_violation
      return new ConflictException(e.detail || 'A record with these values already exists');
    case '23503': // foreign_key_violation
      return new ConflictException(e.detail || 'Foreign key constraint violation');
    case '23502': // not_null_violation
      return new BadRequestException(
        e.column ? `Column "${e.column}" cannot be null` : 'Not-null constraint violation',
      );
    case '23514': // check_violation
      return new BadRequestException('Check constraint violation');
    case '22P02': // invalid_text_representation
    case '22007': // invalid_datetime_format
      return new BadRequestException('Invalid input value');
    case '42703': // undefined_column
      return new BadRequestException('Unknown column in request');
    case '42P01': // undefined_table
      return new NotFoundException(
        'Table not found. Document (NoSQL) projects expose data at /rest/v1/collections/:name',
      );
    default:
      return e; // unknown → NestJS renders a 500
  }
}
