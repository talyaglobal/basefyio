import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { isSupabaseCompat } from './compat';
import {
  isPgError,
  PGRST_STATUS,
  PostgrestErrorBody,
  PostgrestHttpError,
  pgToPostgrest,
  postgrestBody,
} from './errors';

/**
 * Error rendering for the REST data API.
 *
 * Bound on the controller, so it also catches what the API-key guard throws
 * (a controller filter runs before the global one). A caller that is not a
 * PostgREST client gets exactly the platform's usual body from
 * {@link AllExceptionsFilter}; a PostgREST client gets `{code, message,
 * details, hint}` and PostgREST's status for the code, because postgrest-js
 * returns that body verbatim as `error`.
 */
@Catch()
export class PostgrestCompatFilter implements ExceptionFilter {
  private readonly logger = new Logger(PostgrestCompatFilter.name);
  private readonly fallback = new AllExceptionsFilter();

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const compat =
      typeof (req as any).supabaseCompat === 'boolean'
        ? (req as any).supabaseCompat
        : isSupabaseCompat(req.headers);
    if (!compat) return this.fallback.catch(exception, host);

    const res = http.getResponse<Response>();
    const role = (req as any).apiKeyPayload?.dbRole as string | undefined;
    const { status, body } = this.render(exception, role);
    res.status(status).type('application/json').send(JSON.stringify(body));
  }

  private render(exception: unknown, role?: string): { status: number; body: PostgrestErrorBody } {
    if (exception instanceof PostgrestHttpError) {
      return { status: exception.getStatus(), body: exception.body };
    }
    if (exception instanceof HttpException) {
      let status = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === 'string') {
        return { status, body: postgrestBody(defaultCode(status), r) };
      }
      const o = (r ?? {}) as Record<string, unknown>;
      const code = typeof o.code === 'string' ? o.code : undefined;
      if (code && PGRST_STATUS[code] !== undefined) status = PGRST_STATUS[code];
      const message = Array.isArray(o.message)
        ? o.message.join('; ')
        : typeof o.message === 'string'
          ? o.message
          : exception.message;
      return {
        status,
        body: postgrestBody(
          code ?? defaultCode(status),
          message,
          typeof o.details === 'string' ? o.details : null,
          typeof o.hint === 'string' ? o.hint : null,
        ),
      };
    }
    if (isPgError(exception)) {
      const mapped = pgToPostgrest(exception, role) as PostgrestHttpError;
      return { status: mapped.getStatus(), body: mapped.body };
    }
    if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: postgrestBody('XX000', 'Internal server error'),
    };
  }
}

/**
 * A code for an exception that carries none. PostgREST has no catch-all, so
 * the nearest of its own: PGRST301 for a refused credential, 42501 for a
 * refused action, PGRST100 for a malformed request, XX000 for a failure.
 */
function defaultCode(status: number): string {
  switch (status) {
    case 401:
      return 'PGRST301';
    case 403:
      return '42501';
    case 404:
      return 'PGRST205';
    case 406:
      return 'PGRST106';
    default:
      return status >= 500 ? 'XX000' : 'PGRST100';
  }
}
