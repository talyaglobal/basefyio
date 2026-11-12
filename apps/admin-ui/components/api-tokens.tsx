'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import type { ApiToken, CreatedApiToken } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KeyRound, Plus, Copy, Loader2, RefreshCw, Trash2, Check, Pencil, Search, Ban } from 'lucide-react';

function fmtDate(ts?: string | null) {
  return ts ? new Date(ts).toLocaleDateString() : '—';
}

/** Compact relative time like "3d ago" / "5m ago"; em dash when never. */
function ago(ts?: string | null) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

type StatusFilter = 'all' | 'active' | 'revoked';

/** What the row shows: revoked is final; an active token past its expiry is expired. */
function displayStatus(t: ApiToken): 'active' | 'expired' | 'revoked' {
  if (t.status !== 'active') return 'revoked';
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

export function ApiTokens() {
  const router = useRouter();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const load = useCallback(async () => {
    try {
      setTokens(await api.apiTokens.list());
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load API tokens');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    let active = 0;
    let revoked = 0;
    for (const t of tokens) (t.status === 'active' ? active++ : revoked++);
    return { all: tokens.length, active, revoked };
  }, [tokens]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tokens.filter((t) => {
      if (statusFilter === 'active' && t.status !== 'active') return false;
      if (statusFilter === 'revoked' && t.status === 'active') return false;
      if (q && !t.name.toLowerCase().includes(q) && !t.tokenPrefix.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tokens, search, statusFilter]);

  const revoke = async (t: ApiToken) => {
    const ok = await confirmDialog({
      title: 'Revoke token',
      description: `Revoke "${t.name}"? Any agent using it will immediately stop working.`,
      confirmText: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.apiTokens.revoke(t.id);
      toast.success('Token revoked');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Revoke failed');
    }
  };

  const remove = async (t: ApiToken) => {
    const ok = await confirmDialog({
      title: 'Delete token',
      description: `Remove the revoked token "${t.name}" from this list? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.apiTokens.remove(t.id);
      toast.success('Token deleted');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Delete failed');
    }
  };

  const roll = async (t: ApiToken) => {
    const ok = await confirmDialog({
      title: 'Roll token',
      description: `Generate a new secret for "${t.name}"? The current secret stops working immediately.`,
      confirmText: 'Roll',
    });
    if (!ok) return;
    try {
      const res = await api.apiTokens.roll(t.id);
      setCreated(res);
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Roll failed');
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <KeyRound className="h-5 w-5 text-primary" /> API Tokens
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scoped tokens for your agents and scripts to drive your account and projects over the API.
          </p>
        </div>
        <Button onClick={() => router.push('/dashboard/account/api-tokens/new')}>
          <Plus className="mr-1 h-4 w-4" /> Create Token
        </Button>
      </div>

      {/* Toolbar: search + status filter chips */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tokens…"
            className="h-9 w-full rounded-lg border bg-background pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {([
            { key: 'all', label: 'All', n: counts.all },
            { key: 'active', label: 'Active', n: counts.active },
            { key: 'revoked', label: 'Revoked', n: counts.revoked },
          ] as { key: StatusFilter; label: string; n: number }[]).map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                statusFilter === f.key
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              {f.label}
              <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{f.n}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Token</th>
                <th className="px-4 py-2.5 font-medium">Permissions</th>
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">Last used</th>
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">Created</th>
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">Expires</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    {tokens.length === 0
                      ? 'No API tokens yet. Create one to let an agent use your account.'
                      : 'No tokens match your filter.'}
                  </td>
                </tr>
              ) : (
                filtered.map((t) => {
                  const shown = t.scopes.slice(0, 3);
                  const extra = t.scopes.length - shown.length;
                  const state = displayStatus(t);
                  const isActive = t.status === 'active';
                  return (
                    <tr key={t.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium">{t.name}</div>
                        <code className="mt-0.5 inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {t.tokenPrefix}…
                        </code>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex max-w-[280px] flex-wrap items-center gap-1">
                          {shown.map((s) => (
                            <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {s}
                            </span>
                          ))}
                          {extra > 0 && (
                            <span className="text-[11px] font-medium text-muted-foreground">+{extra}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground">
                        {ago(t.lastUsedAt)}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground" title={fmtDate(t.createdAt)}>
                        {ago(t.createdAt)}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground">
                        {t.expiresAt ? fmtDate(t.expiresAt) : 'Never'}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <StatusBadge state={state} />
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex items-center justify-end gap-0.5">
                          {/* A revoked token is final: no edit, no roll — only delete. */}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => router.push(`/dashboard/account/api-tokens/${t.id}/edit`)}
                            title={isActive ? 'Edit' : 'A revoked token cannot be edited'}
                            disabled={!isActive}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => roll(t)}
                            title={
                              state === 'active'
                                ? 'Roll secret'
                                : state === 'expired'
                                  ? 'Set a new expiry date before rolling this token'
                                  : 'A revoked token cannot be rolled'
                            }
                            disabled={state !== 'active'}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                          {isActive ? (
                            <Button size="sm" variant="ghost" onClick={() => revoke(t)} title="Revoke">
                              <Ban className="h-3.5 w-3.5 text-red-500" />
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => remove(t)} title="Delete token">
                              <Trash2 className="h-3.5 w-3.5 text-red-500" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <SecretModal token={created} onClose={() => setCreated(null)} />
    </div>
  );
}

function StatusBadge({ state }: { state: 'active' | 'expired' | 'revoked' }) {
  const style = {
    active: { pill: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300', dot: 'bg-teal-500', label: 'Active' },
    expired: { pill: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300', dot: 'bg-amber-500', label: 'Expired' },
    revoked: { pill: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', dot: 'bg-red-500', label: 'Revoked' },
  }[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${style.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

function SecretModal({ token, onClose }: { token: CreatedApiToken | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!token) return;
    navigator.clipboard.writeText(token.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Dialog open={!!token} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy your API token</DialogTitle>
          <DialogDescription className="text-red-600">
            This is the only time the token is shown. Store it securely — you can&apos;t see it again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2">
          <code className="min-w-0 flex-1 truncate text-xs">{token?.token}</code>
          <Button size="sm" variant="outline" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
