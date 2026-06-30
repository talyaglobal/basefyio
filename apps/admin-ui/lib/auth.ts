const TOKEN_KEY = 'basefyio_access_token';
const REFRESH_KEY = 'basefyio_refresh_token';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function getToken(): string | null {
  return storage()?.getItem(TOKEN_KEY) ?? null;
}

export function getRefreshToken(): string | null {
  return storage()?.getItem(REFRESH_KEY) ?? null;
}

export function setTokens(accessToken: string, refreshToken: string): void {
  storage()?.setItem(TOKEN_KEY, accessToken);
  storage()?.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  storage()?.removeItem(TOKEN_KEY);
  storage()?.removeItem(REFRESH_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

export function parseJwtEmail(token: string): string {
  try {
    const segment = token.split('.')[1];
    if (!segment) return '';
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    return (
      (typeof payload.email === 'string' ? payload.email : '') ||
      (typeof payload.preferred_username === 'string' ? payload.preferred_username : '') ||
      ''
    );
  } catch {
    return '';
  }
}
