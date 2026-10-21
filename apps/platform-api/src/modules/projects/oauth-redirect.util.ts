/**
 * Where a social sign-in may send the browser back to.
 *
 * The OAuth `state` carries the app's `redirect_to`, but state rides in the
 * browser's URL: anyone who can read the project's anon key — it ships in the
 * app's own bundle — can start a flow with a `redirect_to` of their choosing.
 * The callback appends the tokens to the fragment of whatever it redirects to,
 * so following that value unchecked hands an account to the host named in it.
 *
 * Hence the project decides, once, in its auth settings: a redirect is followed
 * only when it is a path inside one of the URLs registered there. A relative
 * path is always allowed — it resolves on the API host, where the tokens are
 * already visible, and nothing new is disclosed.
 */

/** A path on the API host: `/`, `/welcome`, `/auth/cb?x=1`. Never `//host`. */
function isRelativePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !value.includes('://')
  );
}

function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

/** `/` matches the whole origin; `/app` matches `/app` and anything under it. */
function pathCovers(registeredPath: string, requestedPath: string): boolean {
  const base = registeredPath.replace(/\/+$/, '');
  if (base === '') return true;
  return requestedPath === base || requestedPath.startsWith(`${base}/`);
}

/**
 * The URL to redirect to after the provider callback, or null when the project
 * has not registered it. `allowed` is ProjectAuthConfig.redirectUrls.
 */
export function resolveOAuthRedirect(
  requested: string | null | undefined,
  allowed: string[] = [],
): string | null {
  const value = (requested ?? '').trim();
  if (!value) return '/';
  if (isRelativePath(value)) return value;

  const target = parseHttpUrl(value);
  if (!target) return null;

  for (const entry of allowed) {
    const registered = parseHttpUrl((entry ?? '').trim());
    if (!registered) continue;
    if (registered.origin !== target.origin) continue;
    if (!pathCovers(registered.pathname, target.pathname)) continue;
    // The caller appends `#access_token=…`, so the target may not bring a
    // fragment of its own — two of them would break the URL it builds.
    target.hash = '';
    return target.toString();
  }

  return null;
}

/** For the error a developer sees when the URL is not registered yet. */
export function describeAllowedRedirects(allowed: string[] = []): string {
  const list = allowed.map((entry) => (entry ?? '').trim()).filter(Boolean);
  return list.length > 0
    ? list.join(', ')
    : 'none yet — add one under Authentication → Providers → Redirect URLs';
}
