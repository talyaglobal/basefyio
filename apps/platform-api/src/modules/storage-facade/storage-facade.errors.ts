import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * The error body storage-js reads: `{ statusCode, error, message }` with
 * `statusCode` a STRING. Supabase answers most client errors with HTTP 400
 * and puts the real code in the body; storage-js then surfaces it as
 * `StorageApiError.statusCode`. Clients written against Supabase switch on
 * that string ('404', '409'…), so the shape is kept exactly.
 */
export interface StorageErrorBody {
  statusCode: string;
  error: string;
  message: string;
}

/** An error already in Supabase's shape, with the HTTP status it travels under. */
export class StorageFacadeError extends HttpException {
  constructor(
    readonly body: StorageErrorBody,
    httpStatus: number = HttpStatus.BAD_REQUEST,
  ) {
    super(body, httpStatus);
  }

  static notFound(message = 'Object not found'): StorageFacadeError {
    return new StorageFacadeError({ statusCode: '404', error: 'not_found', message });
  }

  static bucketNotFound(): StorageFacadeError {
    return new StorageFacadeError({ statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
  }

  static duplicate(): StorageFacadeError {
    return new StorageFacadeError({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
  }

  static forbidden(message: string): StorageFacadeError {
    return new StorageFacadeError({ statusCode: '403', error: 'Unauthorized', message });
  }

  static rlsDenied(): StorageFacadeError {
    return StorageFacadeError.forbidden('new row violates row-level security policy');
  }

  static invalid(message: string): StorageFacadeError {
    return new StorageFacadeError({ statusCode: '400', error: 'InvalidRequest', message });
  }

  static invalidJwt(message = 'Invalid or expired token'): StorageFacadeError {
    return new StorageFacadeError({ statusCode: '401', error: 'InvalidJWT', message });
  }

  static payloadTooLarge(message = 'The object exceeded the maximum allowed size'): StorageFacadeError {
    return new StorageFacadeError(
      { statusCode: '413', error: 'Payload too large', message },
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }

  static invalidMimeType(mime: string): StorageFacadeError {
    return new StorageFacadeError(
      { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${mime} is not supported` },
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }

  static rangeNotSatisfiable(): StorageFacadeError {
    return new StorageFacadeError(
      { statusCode: '416', error: 'InvalidRange', message: 'Requested range not satisfiable' },
      HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
    );
  }
}

/** Statuses that keep their own HTTP code: clients act on them (retry, back off, shrink the body). */
const KEEP_HTTP_STATUS = new Set([402, 413, 415, 416, 429, 501, 503]);

const ERROR_NAME_BY_STATUS: Record<number, string> = {
  400: 'InvalidRequest',
  401: 'Unauthorized',
  402: 'QuotaExceeded',
  403: 'Unauthorized',
  404: 'not_found',
  405: 'MethodNotAllowed',
  409: 'Duplicate',
  413: 'Payload too large',
  415: 'invalid_mime_type',
  416: 'InvalidRange',
  422: 'InvalidRequest',
  429: 'TooManyRequests',
  501: 'NotImplemented',
  503: 'ServiceUnavailable',
};

function messageOf(exception: HttpException): string {
  const res = exception.getResponse();
  if (typeof res === 'string') return res;
  const m = (res as { message?: unknown })?.message;
  if (Array.isArray(m)) return m.map(String).join('; ');
  return typeof m === 'string' ? m : exception.message;
}

/**
 * Translates whatever a handler or guard threw into Supabase's error shape.
 * Nest's own exceptions (NotFoundException from StorageService, the API key
 * guard's 401/403, the validation pipe's 400) are mapped by status; a
 * StorageFacadeError is sent as it is.
 */
export function toStorageError(exception: unknown): { status: number; body: StorageErrorBody } {
  if (exception instanceof StorageFacadeError) {
    return { status: exception.getStatus(), body: exception.body };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const message = messageOf(exception);
    if (status >= 500) {
      return { status, body: { statusCode: String(status), error: 'InternalError', message } };
    }
    let error = ERROR_NAME_BY_STATUS[status] ?? 'Error';
    let text = message;
    if (status === 404 && /bucket/i.test(message)) {
      error = 'Bucket not found';
      text = 'Bucket not found';
    } else if (status === 404) {
      text = 'Object not found';
    } else if (status === 409) {
      text = 'The resource already exists';
    }
    return {
      status: KEEP_HTTP_STATUS.has(status) ? status : HttpStatus.BAD_REQUEST,
      body: { statusCode: String(status), error, message: text },
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { statusCode: '500', error: 'InternalError', message: 'Internal server error' },
  };
}

/**
 * Controller-scoped: the global filter answers `{ statusCode: <number>,
 * message, timestamp }`, which storage-js cannot read as a Supabase error.
 */
@Catch()
export class SupabaseStorageExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SupabaseStorageExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = toStorageError(exception);
    if (status >= 500 && !(exception instanceof HttpException)) {
      const err = exception as Error;
      this.logger.error(err?.message ?? String(exception), err?.stack);
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(status).type('application/json').send(body);
  }
}
