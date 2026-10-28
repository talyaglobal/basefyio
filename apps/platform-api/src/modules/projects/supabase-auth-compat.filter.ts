import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Errors in the shape GoTrue answers with, for `/auth/v1/*` only.
 *
 * gotrue-js reads `msg` (falling back to `message`), `error_code`, and — when the
 * response says `X-Supabase-Api-Version: 2024-01-01` — `code`. The platform's own
 * filter answers `{statusCode, message, code?}`, which the SDK would show as an
 * `unexpected_failure` with the right text but no code an app can branch on.
 *
 * The services behind the facade throw the platform's exceptions; the table in
 * `translate` turns the ones GoTrue has a name for into that name and status.
 * Anything the facade already shaped (GoTrueError) passes through untouched.
 * Spec: docs/specs/supabase-compat-auth.md §3.
 */

export class GoTrueError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly weakPassword?: { reasons: string[] },
  ) {
    super({ code, message }, status);
  }
}

interface Translation {
  status: number;
  code: string;
  msg: string;
  weak_password?: { reasons: string[] };
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'validation_failed',
  401: 'bad_jwt',
  403: 'no_authorization',
  404: 'not_found',
  409: 'conflict',
  422: 'validation_failed',
  429: 'over_request_rate_limit',
};

/** The platform exceptions GoTrue has a name for. */
export function translate(status: number, message: string, code?: string): Translation {
  const m = message || '';
  if (code === 'totp_required') {
    return { status: 400, code: 'mfa_verification_failed', msg: 'MFA verification failed' };
  }
  if (status === 401 && /invalid email or password/i.test(m)) {
    return { status: 400, code: 'invalid_credentials', msg: 'Invalid login credentials' };
  }
  if (status === 401 && /invalid or expired refresh token/i.test(m)) {
    return { status: 400, code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' };
  }
  if (status === 401 && /invalid or expired access token/i.test(m)) {
    return { status: 401, code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature' };
  }
  if (status === 401 && /(missing apikey|invalid api key|service key must be sent)/i.test(m)) {
    return { status: 401, code: 'no_api_key', msg: 'No API key found in request' };
  }
  if (status === 401 && /challenge has expired/i.test(m)) {
    return { status: 422, code: 'mfa_challenge_expired', msg: 'MFA challenge has expired, verify against another challenge or create a new challenge.' };
  }
  if (status === 401 && /invalid code/i.test(m)) {
    return { status: 422, code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' };
  }
  if (status === 401 && /too many incorrect codes|too many attempts/i.test(m)) {
    return { status: 429, code: 'over_request_rate_limit', msg: m };
  }
  if (status === 409 && /email already (registered|in use)/i.test(m)) {
    return { status: 422, code: 'user_already_exists', msg: 'User already registered' };
  }
  if (status === 409 && /already exists in this project|that email or username is already in use/i.test(m)) {
    return { status: 422, code: 'email_exists', msg: 'A user with this email address has already been registered' };
  }
  if (status === 400 && /password must be at least (\d+)/i.test(m)) {
    const n = m.match(/at least (\d+)/i)?.[1] ?? '6';
    return {
      status: 422,
      code: 'weak_password',
      msg: `Password should be at least ${n} characters.`,
      weak_password: { reasons: ['length'] },
    };
  }
  if (status === 403 && /self-signup is disabled/i.test(m)) {
    return { status: 422, code: 'signup_disabled', msg: 'Signups not allowed for this instance' };
  }
  if (status === 403 && /requires the service key/i.test(m)) {
    return { status: 403, code: 'not_admin', msg: 'User not allowed' };
  }
  if (status === 403 && /requires a signed-in user|acts on the signed-in user|missing authorization header/i.test(m)) {
    return { status: 401, code: 'no_authorization', msg: 'This endpoint requires a Bearer token' };
  }
  if (status === 403 && /does not belong to the requested project/i.test(m)) {
    return { status: 401, code: 'no_api_key', msg: 'Invalid API key' };
  }
  if (status === 403 && /too many attempts/i.test(m)) {
    return { status: 429, code: 'over_request_rate_limit', msg: m };
  }
  if (status === 404 && /project not found/i.test(m)) {
    return { status: 404, code: 'not_found', msg: 'Project not found' };
  }
  if (status === 404 && /user not found/i.test(m)) {
    return { status: 404, code: 'user_not_found', msg: 'User not found' };
  }
  if (status >= 500) {
    return { status, code: code ?? 'unexpected_failure', msg: m || 'Unexpected failure' };
  }
  return { status, code: code ?? DEFAULT_CODES[status] ?? 'unexpected_failure', msg: m || 'Unexpected failure' };
}

@Catch()
export class GoTrueExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GoTrueExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    let t: Translation;

    if (exception instanceof GoTrueError) {
      const res = exception.getResponse() as { message: string };
      t = { status: exception.getStatus(), code: exception.code, msg: res.message, weak_password: exception.weakPassword };
    } else if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const message = typeof res === 'string' ? res : (res as any)?.message;
      const text = Array.isArray(message) ? message.join('; ') : typeof message === 'string' ? message : exception.message;
      const code = typeof res === 'object' && res && typeof (res as any).code === 'string' ? (res as any).code : undefined;
      t = translate(exception.getStatus(), text, code);
    } else {
      if (exception instanceof Error) this.logger.error(exception.message, exception.stack);
      t = { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'unexpected_failure', msg: 'Internal server error' };
    }

    if (t.status >= 500 && !(exception instanceof GoTrueError)) {
      this.logger.warn(`${t.status} ${t.code}: ${t.msg}`);
    }

    response.setHeader('X-Supabase-Api-Version', '2024-01-01');
    response.status(t.status).json({
      code: t.code,
      error_code: t.code,
      msg: t.msg,
      message: t.msg,
      ...(t.weak_password ? { weak_password: t.weak_password } : {}),
    });
  }
}
