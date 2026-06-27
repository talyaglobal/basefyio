'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

type QbStatus = Awaited<ReturnType<typeof api.billing.quickbooksStatus>>;

export function QuickbooksTab() {
  const [status, setStatus] = useState<QbStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.billing.quickbooksStatus());
    } catch (err: any) {
      toast.error(err.message || 'Failed to load QuickBooks status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Surface the OAuth callback result (?qb=connected|error)
    const p = new URLSearchParams(window.location.search);
    const qb = p.get('qb');
    if (qb === 'connected') toast.success('QuickBooks connected');
    else if (qb === 'error') toast.error(`QuickBooks connection failed: ${p.get('reason') || ''}`);
    if (qb) window.history.replaceState(null, '', '/dashboard/management');
  }, [load]);

  async function connect() {
    setBusy(true);
    try {
      const { url } = await api.billing.quickbooksAuthorizeUrl();
      window.location.href = url;
    } catch (err: any) {
      toast.error(err.message || 'Could not start QuickBooks connection');
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.billing.quickbooksDisconnect();
      toast.success('QuickBooks disconnected');
      await load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  }

  async function toggleAuto() {
    if (!status) return;
    setBusy(true);
    try {
      const { autoCreate } = await api.billing.quickbooksSetAutoCreate(!status.autoCreate);
      setStatus({ ...status, autoCreate });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update setting');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" /></div>;
  }
  if (!status) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">QuickBooks</h2>
        <p className="text-sm text-muted-foreground">
          Connect your QuickBooks Online company. A <strong>Sales Receipt</strong> is created for every
          successful, paid sale (proof of a captured payment) — the correct US-accounting document for
          an already-paid subscription charge.
        </p>
      </div>

      {!status.configured ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-300">QuickBooks is not configured yet</p>
          <p className="mt-1 text-muted-foreground">
            Set these environment variables on the API, then this page can connect:
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-muted/50 p-3 text-xs">{`QUICKBOOKS_CLIENT_ID=...
QUICKBOOKS_CLIENT_SECRET=...
QUICKBOOKS_REDIRECT_URI=https://api.basefyio.com/api/admin/quickbooks/callback
QUICKBOOKS_ENVIRONMENT=production`}</pre>
          <p className="mt-2 text-muted-foreground">
            Create the app at <span className="font-mono">developer.intuit.com</span> (scope: Accounting),
            and register the exact redirect URI above.
          </p>
        </div>
      ) : status.connected ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Connected to <strong>{status.companyName || 'your QuickBooks company'}</strong>
            <span className="text-muted-foreground">· {status.environment}</span>
          </div>

          <label className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="text-sm font-medium text-foreground">Create a Sales Receipt on every sale</p>
              <p className="text-xs text-muted-foreground">When off, no documents are pushed to QuickBooks.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={status.autoCreate}
              disabled={busy}
              onClick={toggleAuto}
              className={`relative h-6 w-11 rounded-full transition-colors ${status.autoCreate ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${status.autoCreate ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </label>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={connect} disabled={busy}>Reconnect</Button>
            <Button variant="destructive" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button onClick={connect} disabled={busy}>
            {busy ? 'Redirecting…' : 'Connect QuickBooks'}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            You&apos;ll be sent to Intuit to authorize, then returned here.
          </p>
        </div>
      )}
    </div>
  );
}
