import Cookies from 'js-cookie';
import type { AuthTokens, UserInfo } from './types';

const TOKEN_KEY = 'kb_access_token';
const REFRESH_KEY = 'kb_refresh_token';
const ID_TOKEN_KEY = 'kb_id_token';
const AUTH_MARKER_KEY = 'kb_logged_in';
const FORCE_PASSWORD_CHANGE_KEY = 'kb_force_password_change';

/** Root domain for cross-subdomain cookies (e.g. `.kolaybase.com`). */
function getRootDomain(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return undefined;
  const parts = hostname.split('.');
  if (parts.length < 2) return undefined;
  return `.${parts.slice(-2).join('.')}`;
}

function getStorage() {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function getAccessToken(): string | undefined {
  const storage = getStorage();
  return storage?.getItem(TOKEN_KEY) || Cookies.get(TOKEN_KEY);
}

export function setTokens(tokens: AuthTokens) {
  const storage = getStorage();
  storage?.setItem(TOKEN_KEY, tokens.accessToken);
  storage?.setItem(REFRESH_KEY, tokens.refreshToken);
  if (tokens.idToken) {
    storage?.setItem(ID_TOKEN_KEY, tokens.idToken);
  } else {
    storage?.removeItem(ID_TOKEN_KEY);
  }
  Cookies.set(TOKEN_KEY, tokens.accessToken, {
    expires: 7,
    sameSite: 'lax',
    path: '/',
  });
  Cookies.set(REFRESH_KEY, tokens.refreshToken, {
    expires: 30,
    sameSite: 'lax',
    path: '/',
  });
  // Small marker cookie for middleware checks; avoids JWT cookie size limits.
  // Set on root domain so the marketing site can detect logged-in state.
  const rootDomain = getRootDomain();
  Cookies.set(AUTH_MARKER_KEY, '1', {
    expires: 30,
    sameSite: 'lax',
    path: '/',
    ...(rootDomain ? { domain: rootDomain } : {}),
  });
  if (tokens.forcePasswordChange) {
    Cookies.set(FORCE_PASSWORD_CHANGE_KEY, '1', {
      expires: 7,
      sameSite: 'lax',
      path: '/',
    });
  } else {
    Cookies.remove(FORCE_PASSWORD_CHANGE_KEY, { path: '/' });
  }
}

export function clearTokens() {
  const storage = getStorage();
  storage?.removeItem(TOKEN_KEY);
  storage?.removeItem(REFRESH_KEY);
  storage?.removeItem(ID_TOKEN_KEY);
  Cookies.remove(TOKEN_KEY, { path: '/' });
  Cookies.remove(REFRESH_KEY, { path: '/' });
  const rootDomain = getRootDomain();
  Cookies.remove(AUTH_MARKER_KEY, { path: '/', ...(rootDomain ? { domain: rootDomain } : {}) });
  Cookies.remove(FORCE_PASSWORD_CHANGE_KEY, { path: '/' });
}

export function getRefreshToken(): string | undefined {
  const storage = getStorage();
  return storage?.getItem(REFRESH_KEY) || Cookies.get(REFRESH_KEY);
}

export function getIdToken(): string | undefined {
  const storage = getStorage();
  return storage?.getItem(ID_TOKEN_KEY) || undefined;
}

/** Decode JWT payload segment (handles base64url used by Keycloak). */
function decodeJwtPayloadSegment(segment: string): Record<string, unknown> | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickLoginLabel(payload: Record<string, unknown>): string {
  const email = payload.email;
  const preferred = payload.preferred_username;
  if (typeof email === 'string' && email.trim()) return email.trim();
  if (typeof preferred === 'string' && preferred.trim()) return preferred.trim();
  const sub = payload.sub;
  if (typeof sub === 'string' && sub.trim()) return sub.trim();
  return '';
}

export function parseJwt(token: string): UserInfo | null {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const payload = decodeJwtPayloadSegment(segment);
    if (!payload) return null;
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) return null;
    const email = pickLoginLabel(payload);
    const preferred_username =
      typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : email || sub;
    const roles = (payload.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
    return {
      sub,
      email,
      preferred_username,
      roles,
    };
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return !!getAccessToken();
}

export function getTokenExpiry(): number | null {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const payload = decodeJwtPayloadSegment(segment);
    const exp = payload?.exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function startProactiveRefresh() {
  stopProactiveRefresh();

  function schedule() {
    const expiry = getTokenExpiry();
    if (!expiry) return;

    // Refresh well before expiry to avoid 401 bursts and surprise logouts on slow networks
    const delay = Math.max(expiry - Date.now() - 180_000, 5_000);

    refreshTimer = setTimeout(async () => {
      const rt = getRefreshToken();
      if (!rt) return;
      try {
        const res = await fetch('/api/proxy/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
        if (res.ok) {
          const tokens: AuthTokens = await res.json();
          setTokens(tokens);
          schedule();
          return;
        }

        // Hard auth failures: refresh token invalid/expired.
        if (res.status === 400 || res.status === 401) {
          clearTokens();
          return;
        }

        // Transient failure: retry later without forcing logout.
        refreshTimer = setTimeout(schedule, 30_000);
      } catch {
        // Network issue: retry later without forcing logout.
        refreshTimer = setTimeout(schedule, 30_000);
      }
    }, delay);
  }

  schedule();
}

export function stopProactiveRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}
