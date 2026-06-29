'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

function money(cents: number, currency = 'usd') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format((cents || 0) / 100);
}
function dollars(n: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'USD').toUpperCase() }).format(n || 0);
}
function fmtDate(d?: string | null) {
  return d ? new Date(d).toLocaleString() : '—';
}

export function QuickbooksTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.billing.quickbooksDashboard());
    } catch (err: any) {
      toast.error(err.message || 'Failed to load QuickBooks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
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
      toast.error(err.message || 'Could not start connection');
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try { await api.billing.quickbooksDisconnect(); toast.success('Disconnected'); await load(); }
    catch (err: any) { toast.error(err.message); } finally { setBusy(false); }
  }
  async function toggleAuto() {
    setBusy(true);
    try { const r = await api.billing.quickbooksSetAutoCreate(!data.autoCreate); setData({ ...data, autoCreate: r.autoCreate }); }
    catch (err: any) { toast.error(err.message); } finally { setBusy(false); }
  }
  async function runTest() {
    setTesting(true);
    try {
      const r = await api.billing.quickbooksTest();
      toast.success(`Test Sales Receipt created (#${r.docNumber || r.id})`);
      await load();
      if (r.url) window.open(r.url, '_blank');
    } catch (err: any) {
      toast.error(err.message || 'Test failed');
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" /></div>;
  }
  if (!data) return null;

  // Not connected / not configured states
  if (!data.connected) {
    return (
      <div className="space-y-4">
        <Header />
        {!data.configured ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-300">QuickBooks is not configured</p>
            <p className="mt-1 text-muted-foreground">Set QUICKBOOKS_CLIENT_ID / SECRET / REDIRECT_URI on the API, then connect.</p>
          </div>
        ) : (
          <div>
            <Button onClick={connect} disabled={busy}>{busy ? 'Redirecting…' : 'Connect QuickBooks'}</Button>
          </div>
        )}
      </div>
    );
  }

  const s = data.summary || {};
  const live = data.live || {};

  return (
    <div className="space-y-6">
      <Header />

      {/* Connection banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          Connected to <strong>{data.companyName || live.company?.name || 'your company'}</strong>
          <span className="text-muted-foreground">· {data.environment} · since {fmtDate(data.connectedAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={runTest} disabled={testing}>{testing ? 'Creating…' : 'Run test receipt'}</Button>
          <Button variant="outline" size="sm" onClick={load} disabled={busy}>Refresh</Button>
          <Button variant="outline" size="sm" onClick={connect} disabled={busy}>Reconnect</Button>
          <Button variant="destructive" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="In QuickBooks" value={String(s.success ?? 0)} tone="emerald" />
        <Stat label="Deleted in QB" value={String(s.deleted ?? 0)} />
        <Stat label="Failed" value={String(s.failed ?? 0)} tone={s.failed ? 'red' : undefined} />
        <Stat label="Total synced amount" value={money(s.totalAmountCents ?? 0)} />
      </div>

      {/* Auto-create toggle */}
      <label className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <p className="text-sm font-medium text-foreground">Create a Sales Receipt on every sale</p>
          <p className="text-xs text-muted-foreground">When off, no documents are pushed to QuickBooks. Last sync: {fmtDate(s.lastSyncAt)}</p>
        </div>
        <button type="button" role="switch" aria-checked={data.autoCreate} disabled={busy} onClick={toggleAuto}
          className={`relative h-6 w-11 rounded-full transition-colors ${data.autoCreate ? 'bg-primary' : 'bg-muted'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${data.autoCreate ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </label>

      {/* Live QuickBooks Sales Receipts */}
      <section className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Sales Receipts in QuickBooks {live.company?.name ? `· ${live.company.name}` : ''}</h3>
          {live.available && <span className="text-xs text-muted-foreground">{live.salesReceiptCount} shown · {dollars(live.salesReceiptTotal)}</span>}
        </div>
        {!live.available ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            Could not read live QuickBooks data{live.error ? `: ${live.error}` : ''}.
          </p>
        ) : live.salesReceipts.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">No Sales Receipts in QuickBooks yet. Use “Run test receipt” or wait for the next paid sale.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2">Date</th><th className="px-4 py-2">Doc #</th><th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Note</th><th className="px-4 py-2"></th>
              </tr></thead>
              <tbody>
                {live.salesReceipts.map((r: any) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-4 py-2">{r.txnDate || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.docNumber || r.id}</td>
                    <td className="px-4 py-2">{r.customer || '—'}</td>
                    <td className="px-4 py-2 text-right font-medium">{dollars(r.total, r.currency)}</td>
                    <td className="px-4 py-2 max-w-[260px] truncate text-xs text-muted-foreground" title={r.privateNote || ''}>{r.privateNote || '—'}</td>
                    <td className="px-4 py-2 text-right"><a href={r.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Open ↗</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Local sync log (incl. failures) */}
      <section className="rounded-lg border">
        <div className="border-b px-4 py-3"><h3 className="text-sm font-semibold">Sync activity (basefyio → QuickBooks)</h3></div>
        {(!data.recentSyncs || data.recentSyncs.length === 0) ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">No sync activity yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2">When</th><th className="px-4 py-2">Customer</th><th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">Status</th><th className="px-4 py-2">Receipt</th>
              </tr></thead>
              <tbody>
                {data.recentSyncs.map((l: any) => (
                  <tr key={l.id} className="border-b last:border-0">
                    <td className="px-4 py-2">{fmtDate(l.createdAt)}</td>
                    <td className="px-4 py-2">{l.customerName || '—'}</td>
                    <td className="px-4 py-2 text-right font-medium">{money(l.amountCents, l.currency)}</td>
                    <td className="px-4 py-2">
                      {l.status === 'success'
                        ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">success</span>
                        : <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-600 dark:text-red-400" title={l.error || ''}>failed</span>}
                    </td>
                    <td className="px-4 py-2">{l.url ? <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Open ↗</a> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">QuickBooks</h2>
      <p className="text-sm text-muted-foreground">
        A <strong>Sales Receipt</strong> is created in QuickBooks for every successful, paid sale (the correct
        US-accounting document for an already-paid charge). Live data below is pulled directly from QuickBooks.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'red' }) {
  const color = tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'red' ? 'text-red-600 dark:text-red-400' : 'text-foreground';
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
