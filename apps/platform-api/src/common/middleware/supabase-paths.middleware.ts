/**
 * The URL shapes a Supabase client produces, mapped onto this API's routes.
 *
 * A Supabase client is given one base URL and derives `/auth/v1`, `/rest/v1`,
 * `/storage/v1` and `/realtime/v1` from it. With `supabaseUrl = …/api` those
 * land under the global prefix as they are; with the bare host they are put
 * there here. A base of `/api/p/<projectId>` names the project in the path
 * rather than with a key — for the one route a browser reaches by navigation
 * and so cannot send headers to (`GET /auth/v1/authorize`) — and becomes the
 * `x-bf-project` header that route reads, plus `x-project-id` for the usage
 * middleware, which attributes a request to its project by it.
 *
 * Plain functions on the request, so main.ts can register them and a test can
 * call them without a server.
 */

/** What a request that is not a storage upload may take to arrive in full. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** What a storage upload may take: becomes `server.requestTimeout` for the whole process. */
export const STORAGE_REQUEST_TIMEOUT_MS = 30 * 60_000;

const STORAGE_OBJECT_PREFIXES = ['/api/storage/v1/object/', '/storage/v1/object/'];

interface RequestLike {
  url?: string;
  method?: string;
  headers: Record<string, unknown>;
  /** Set by Node once the whole request (headers and body) has arrived. */
  complete?: boolean;
  destroy?: () => void;
  once?: (event: string, listener: () => void) => unknown;
}

interface ResponseLike {
  once?: (event: string, listener: () => void) => unknown;
}

/**
 * `POST|PUT /storage/v1/object/<bucket>/<path>` — the body is the file itself,
 * streamed to the store, never something a body parser may consume. The object
 * routes whose bodies are JSON (list, sign, move, copy, upload/sign) are not.
 */
export function isRawStorageUpload(req: { method?: string; url?: string }): boolean {
  if (req.method !== 'POST' && req.method !== 'PUT') return false;
  const path = (req.url ?? '').split('?')[0];
  const prefix = STORAGE_OBJECT_PREFIXES.find((p) => path.startsWith(p));
  if (!prefix) return false;
  const rest = path.slice(prefix.length);
  if (/^(list|sign|move|copy)(\/|$)/.test(rest)) return false;
  if (req.method === 'POST' && /^upload\/sign(\/|$)/.test(rest)) return false;
  return true;
}

/** Whether the request's media type (parameters stripped) matches. */
export function hasMediaType(req: { headers?: Record<string, unknown> }, pattern: RegExp): boolean {
  const raw = req.headers?.['content-type'];
  const type = (typeof raw === 'string' ? raw : '').split(';')[0].trim();
  return pattern.test(type);
}

/** The body-parser `type` predicate for JSON: everything JSON except a raw upload. */
export const isJsonBody = (req: RequestLike) =>
  !isRawStorageUpload(req) && hasMediaType(req, /^application\/(.+\+)?json$/i);

/** The body-parser `type` predicate for forms, with the same carve-out. */
export const isFormBody = (req: RequestLike) =>
  !isRawStorageUpload(req) && hasMediaType(req, /^application\/x-www-form-urlencoded$/i);

/**
 * The bound `server.requestTimeout` used to give every request: it must arrive
 * in full within REQUEST_TIMEOUT_MS. Only the arrival — the response may take
 * as long as it needs, as before: progress streams that write only when
 * something changes, and handlers that work for minutes before answering, must
 * not be cut off. (A socket inactivity timeout would cut them off.)
 */
export function boundRequestArrival(req: RequestLike, res: ResponseLike, ms = REQUEST_TIMEOUT_MS): void {
  if (req.complete) return;
  const timer = setTimeout(() => {
    if (!req.complete) req.destroy?.();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  const clear = () => clearTimeout(timer);
  req.once?.('end', clear);
  req.once?.('close', clear);
  res.once?.('finish', clear);
  res.once?.('close', clear);
}

/**
 * `/auth|rest|storage|realtime/v1/…` → `/api/…`; `/api/p/<projectId>/…` →
 * `/api/…` with the project in `x-bf-project` and `x-project-id`. Also puts the
 * ordinary two-minute arrival bound back on every request that is not an upload
 * (the server's `requestTimeout` is raised to an upload's worth for everyone).
 */
export function rewriteSupabasePaths(req: RequestLike, res: ResponseLike, next: () => void): void {
  let url = req.url ?? '';
  if (/^\/(auth|rest|storage|realtime)\/v1(\/|\?|$)/.test(url) || /^\/p\/[^/?]+(\/|\?|$)/.test(url)) {
    url = `/api${url}`;
  }
  const scoped = /^\/api\/p\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(url);
  if (scoped) {
    req.headers['x-bf-project'] = scoped[1];
    req.headers['x-project-id'] = scoped[1];
    url = `/api${scoped[2] || '/'}${scoped[3] ?? ''}`;
  }
  req.url = url;
  if (!isRawStorageUpload(req)) boundRequestArrival(req, res ?? {});
  next();
}
