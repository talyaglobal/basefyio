import type { BasefyioError } from './types.js';

/**
 * Every `error` the SDK returns has the same shape: `message`, plus `status`
 * when the server answered and `code` when there is a machine-readable one —
 * Postgres' SQLSTATE for a database error (`23505` for a duplicate key), the
 * API's own code otherwise, or one of the client codes below when no request
 * was made or none got through.
 *
 * - `network_error` — the request never reached the API (offline, DNS, CORS).
 * - `invalid_request` — the SDK refused the call before sending it (no data to
 *   insert, an unfiltered delete, a limit that is not a whole number…).
 */
export type ClientErrorCode = 'network_error' | 'invalid_request';

/** An error the SDK raises itself, before or instead of a request. */
export class BasefyioClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string = 'invalid_request', status?: number) {
    super(message);
    this.name = 'BasefyioClientError';
    this.code = code;
    this.status = status;
  }
}

/** Normalise anything caught into a {@link BasefyioError}. */
export function toBasefyioError(err: unknown): BasefyioError {
  if (err instanceof BasefyioClientError) {
    const out: BasefyioError = { message: err.message, code: err.code };
    if (err.status !== undefined) out.status = err.status;
    return out;
  }
  // fetch() rejects with a TypeError when the request could not be made at all.
  if (err instanceof TypeError) {
    return { message: `Network error: ${err.message}`, code: 'network_error' };
  }
  if (err instanceof Error) {
    return { message: err.message, code: 'invalid_request' };
  }
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; status?: unknown; code?: unknown };
    const out: BasefyioError = {
      message: typeof e.message === 'string' && e.message ? e.message : 'Request failed',
    };
    if (typeof e.status === 'number') out.status = e.status;
    if (typeof e.code === 'string' && e.code) out.code = e.code;
    return out;
  }
  return { message: typeof err === 'string' && err ? err : 'Request failed' };
}

/**
 * JSON for a request body. A `bigint` — the natural type for a Postgres
 * bigint id — has no JSON form and made `JSON.stringify` throw "Do not know how
 * to serialize a BigInt"; it is sent as its decimal string, which Postgres
 * reads back into any integer or numeric column exactly.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}
