/**
 * What went wrong when the identity service refused a user.
 *
 * The Keycloak admin client reports every non-2xx answer with the same words,
 * "Network response was not OK", and keeps the real status and body on the error
 * object. The import printed only the words, so a user that could not be created
 * (the project owner's account, in one case) came back with no clue why.
 */
export interface KeycloakLikeError {
  message?: string;
  response?: { status?: number } | null;
  responseData?: unknown;
  status?: number;
}

/** `HTTP 409 — User exists with same username`, or the plain message when there is no HTTP answer. */
export function describeKeycloakError(err: KeycloakLikeError | null | undefined): string {
  if (!err) return 'unknown error';
  const status = err.response?.status ?? err.status;
  const data = err.responseData;
  let body = '';
  if (typeof data === 'string') body = data;
  else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    body = String(d.errorMessage ?? d.error_description ?? d.error ?? d.message ?? '');
    if (!body) {
      try {
        body = JSON.stringify(data);
      } catch {
        body = '';
      }
    }
  }
  body = body.replace(/\s+/g, ' ').trim().slice(0, 240);
  const generic = /^Network response was not OK$/i.test((err.message ?? '').trim());
  if (status) return body ? `HTTP ${status} — ${body}` : `HTTP ${status}${generic ? '' : ` — ${err.message ?? ''}`}`;
  return err.message || 'unknown error';
}

/** A failure worth trying again: the service was busy, restarting or unreachable. */
export function isTransientUserError(err: KeycloakLikeError | null | undefined): boolean {
  if (!err) return false;
  const status = err.response?.status ?? err.status;
  if (typeof status === 'number') return [408, 425, 429, 502, 503, 504].includes(status);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error/i.test(err.message ?? '');
}
