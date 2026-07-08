'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import type { ApiToken, CreatedApiToken } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KeyRound, Plus, Copy, Loader2, RefreshCw, Trash2, Check, Pencil } from 'lucide-react';

function fmt(ts?: string | null) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export function ApiTokens() {
  const router = useRouter();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

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
        <Button onClick={() => router.push('/dashboard/account/api-tokens/new')}>
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => router.push(`/dashboard/account/api-tokens/${t.id}/edit`)}
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
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

      <SecretModal token={created} onClose={() => setCreated(null)} />
    </div>
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
