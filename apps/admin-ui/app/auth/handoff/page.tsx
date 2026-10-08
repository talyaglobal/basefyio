'use client';

import { useEffect } from 'react';
import { getAccessToken, getIdToken, getRefreshToken, getTokenExpiry } from '@/lib/auth';

/**
 * Runs on app.<domain> and hands its session to the admin console on
 * admin.<domain>, which keeps its own localStorage. The tokens travel in the
 * URL fragment (never sent to a server), the same way the OAuth callback
 * delivers them, and only ever to the admin host of this same domain.
 */
export default function SessionHandoffPage() {
  useEffect(() => {
    const host = window.location.hostname;
    if (!host.startsWith('app.')) {
      window.location.replace('/dashboard');
      return;
    }
    const consoleOrigin = `https://admin.${host.slice('app.'.length)}`;

    const requested = new URLSearchParams(window.location.search).get('next') || '';
    const next = requested === '/console' || requested.startsWith('/console/') ? requested : '/console';
    const loginUrl = `${consoleOrigin}/login?next=${encodeURIComponent(next)}`;

    const accessToken = getAccessToken();
    const refreshToken = getRefreshToken();
    if (!accessToken || !refreshToken) {
      // Nothing to hand over: let the console show its sign-in form.
      window.location.replace(`${loginUrl}&handoff=none`);
      return;
    }

    const expiry = getTokenExpiry();
    const fragment = new URLSearchParams({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: String(expiry ? Math.max(0, Math.floor((expiry - Date.now()) / 1000)) : 300),
      token_type: 'Bearer',
    });
    const idToken = getIdToken();
    if (idToken) fragment.set('id_token', idToken);
    window.location.replace(`${loginUrl}#${fragment.toString()}`);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
    </div>
  );
}
