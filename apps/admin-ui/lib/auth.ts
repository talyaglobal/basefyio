import Cookies from 'js-cookie';
import type { AuthTokens, UserInfo } from './types';

const TOKEN_KEY = 'kb_access_token';
const REFRESH_KEY = 'kb_refresh_token';

export function getAccessToken(): string | undefined {
  return Cookies.get(TOKEN_KEY);
}

export function setTokens(tokens: AuthTokens) {
  Cookies.set(TOKEN_KEY, tokens.accessToken, {
    expires: 7,
    sameSite: 'lax',
  });
  Cookies.set(REFRESH_KEY, tokens.refreshToken, {
    expires: 30,
    sameSite: 'lax',
  });
}

export function clearTokens() {
  Cookies.remove(TOKEN_KEY);
  Cookies.remove(REFRESH_KEY);
}

export function getRefreshToken(): string | undefined {
  return Cookies.get(REFRESH_KEY);
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
