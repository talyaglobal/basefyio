'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Terminal, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { getAccessToken, getRefreshToken, clearTokens } from '@/lib/auth';
import { Button } from '@/components/ui/button';

function CliAuthorizeContent() {
  const searchParams = useSearchParams();
  const cliState = searchParams.get('cli_state');

  const [port, setPort] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    // If not authenticated, redirect to login and come back here afterward
    if (!getAccessToken()) {
      window.location.assign(`/login?cli_state=${encodeURIComponent(cliState ?? '')}`);
      return;
    }

    if (!cliState) {
      setStatus('error');
      return;
    }

    api.auth.getCliStatePort(cliState)
      .then((data) => {
        setPort(data.port);
        setStatus('ready');
      })
      .catch((err) => {
        // If the session token is expired/invalid, clear it and redirect to
        // login so the user re-authenticates automatically instead of seeing
        // a dead-end error page.
        const status = err?.response?.status ?? err?.status;
        if (status === 401 || status === 403) {
          clearTokens();
          window.location.assign(`/login?cli_state=${encodeURIComponent(cliState ?? '')}`);
          return;
        }
        setStatus('error');
      });
  }, [cliState]);

  async function handleAllow() {
    if (!cliState || port === null) return;
    setActionLoading(true);
    try {
      const refreshToken = getRefreshToken();
      if (!refreshToken) throw new Error('No refresh token');
      const { exchangeCode, port: loopbackPort } = await api.auth.cliAuthorize(cliState, refreshToken);
      window.location.href = `http://127.0.0.1:${loopbackPort}/callback?code=${encodeURIComponent(exchangeCode)}`;
    } catch {
      setActionLoading(false);
      setStatus('error');
    }
  }

  function handleDeny() {
    if (port === null) return;
    window.location.href = `http://127.0.0.1:${port}/callback?error=access_denied`;
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
        <div className="max-w-sm w-full text-center space-y-4 rounded-lg border bg-card p-8 shadow-sm">
          <XCircle className="mx-auto h-10 w-10 text-destructive" />
          <h1 className="text-lg font-semibold">Session expired or invalid</h1>
          <p className="text-sm text-muted-foreground">
            This CLI session has expired or is invalid. Run{' '}
            <code className="font-mono bg-muted px-1 rounded text-xs">kb login</code> again to start a new session.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        {/* Icon */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Terminal className="h-6 w-6" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold">Connect CLI to your account</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The Kolaybase CLI is requesting access to your account.
            </p>
          </div>
        </div>

        {/* Permissions list */}
        <ul className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
          {[
            'Read and manage your projects',
            'Run database migrations',
            'Access secrets and environment variables',
          ].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 shrink-0 text-primary" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        {/* Actions */}
        <div className="flex flex-col gap-3">
          <Button
            className="w-full"
            onClick={handleAllow}
            disabled={actionLoading}
          >
            {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Allow access
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={handleDeny}
            disabled={actionLoading}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function CliAuthorizePage() {
  return (
    <Suspense>
      <CliAuthorizeContent />
    </Suspense>
  );
}
