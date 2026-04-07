import Cookies from 'js-cookie';
import type { AuthTokens, UserInfo } from './types';

const TOKEN_KEY = 'kb_access_token';
const REFRESH_KEY = 'kb_refresh_token';
const AUTH_MARKER_KEY = 'kb_logged_in';
const FORCE_PASSWORD_CHANGE_KEY = 'kb_force_password_change';

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
  Cookies.set(AUTH_MARKER_KEY, '1', {
    expires: 30,
    sameSite: 'lax',
    path: '/',
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
  Cookies.remove(TOKEN_KEY, { path: '/' });
  Cookies.remove(REFRESH_KEY, { path: '/' });
  Cookies.remove(AUTH_MARKER_KEY, { path: '/' });
  Cookies.remove(FORCE_PASSWORD_CHANGE_KEY, { path: '/' });
}

export function getRefreshToken(): string | undefined {
  const storage = getStorage();
  return storage?.getItem(REFRESH_KEY) || Cookies.get(REFRESH_KEY);
}

export function parseJwt(token: string): UserInfo | null {
  try {
    const base64 = token.split('.')[1];
    const payload = JSON.parse(atob(base64));
    return {
      sub: payload.sub,
      email: payload.email,
      preferred_username: payload.preferred_username,
      roles: payload.realm_access?.roles ?? [],
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
    const payload = JSON.parse(atob(token.split('.')[1]));
    return (payload.exp as number) * 1000;
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

    // Refresh 60 seconds before expiry
    const delay = Math.max(expiry - Date.now() - 60_000, 5_000);

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
        }
      } catch {}
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
