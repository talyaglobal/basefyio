'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import type { ApiToken, ApiTokenScopeGroup, CreatedApiToken } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KeyRound, Plus, Copy, Loader2, RefreshCw, Trash2, Check } from 'lucide-react';

function fmt(ts?: string | null) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [groups, setGroups] = useState<ApiTokenScopeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, g] = await Promise.all([api.apiTokens.list(), api.apiTokens.scopes()]);
      setTokens(t);
      setGroups(g);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load API tokens');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <KeyRound className="h-5 w-5 text-primary" /> API Tokens
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scoped tokens for your agents and scripts to drive your account and projects over the API.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Create Token
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : tokens.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No API tokens yet. Create one to let an agent use your account.
        </div>
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => (
            <div key={t.id} className="rounded-lg border bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{t.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t.tokenPrefix}…
                    </code>
                    {t.status !== 'active' && (
                      <Badge variant="secondary" className="text-xs text-red-600">
                        {t.status}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <Badge key={s} variant="secondary" className="text-[11px] font-normal">
                        {s}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Last used {fmt(t.lastUsedAt)} · Created {fmt(t.createdAt)}
                    {t.expiresAt ? ` · Expires ${fmt(t.expiresAt)}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => roll(t)} title="Roll secret">
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => revoke(t)} title="Revoke">
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        groups={groups}
        onCreated={(res) => {
          setCreated(res);
          load();
        }}
      />
      <SecretModal token={created} onClose={() => setCreated(null)} />
    </div>
  );
}

function CreateTokenDialog({
  open,
  onOpenChange,
  groups,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groups: ApiTokenScopeGroup[];
  onCreated: (res: CreatedApiToken) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = (s: string) =>
    setScopes((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  const toggleGroup = (g: ApiTokenScopeGroup) =>
    setScopes((prev) => {
      const next = new Set(prev);
      const all = g.scopes.every((s) => next.has(s.scope));
      g.scopes.forEach((s) => (all ? next.delete(s.scope) : next.add(s.scope)));
      return next;
    });

  const save = async () => {
    if (!name.trim()) return toast.error('Name is required');
    if (scopes.size === 0) return toast.error('Select at least one scope');
    setSaving(true);
    try {
      const res = await api.apiTokens.create({
        name: name.trim(),
        scopes: [...scopes],
        expiresAt: expiresAt || undefined,
      });
      onOpenChange(false);
      setName('');
      setScopes(new Set());
      setExpiresAt('');
      onCreated(res);
    } catch (e: any) {
      toast.error(e?.message || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription>Grant only the scopes the agent needs.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="token-name">Name</Label>
            <Input
              id="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="orders-agent"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Scopes</Label>
            <div className="space-y-3 rounded-md border p-3">
              {groups.map((g) => {
                const allOn = g.scopes.every((s) => scopes.has(s.scope));
                return (
                  <div key={g.resource}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g)}
                      className="mb-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                    >
                      {g.label} {allOn ? '(clear)' : '(all)'}
                    </button>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      {g.scopes.map((s) => (
                        <label
                          key={s.scope}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                          title={s.description}
                        >
                          <input
                            type="checkbox"
                            checked={scopes.has(s.scope)}
                            onChange={() => toggle(s.scope)}
                          />
                          <code className="text-xs">{s.scope}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="token-exp">Expiry (optional)</Label>
            <Input
              id="token-exp"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
