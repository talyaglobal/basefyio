'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ApiTokenScopeGroup, CreatedApiToken } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ArrowLeft, KeyRound, Loader2, Copy, Check, ShieldCheck, AlertCircle } from 'lucide-react';

/** Today as YYYY-MM-DD in the viewer's local time (the earliest pickable expiry). */
function todayLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A picked expiry day lasts until the end of that day in the viewer's local time. */
function endOfDayIso(day: string) {
  const d = new Date(`${day}T23:59:59`);
  return isNaN(d.getTime()) ? day : d.toISOString();
}

/** YYYY-MM-DD of an ISO timestamp in the viewer's local time. */
function localDay(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ApiTokenCreate({ tokenId }: { tokenId?: string } = {}) {
  const router = useRouter();
  const isEdit = !!tokenId;
  const [groups, setGroups] = useState<ApiTokenScopeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  // Form errors render inline next to the buttons. A toast here sat on top of
  // the sticky Create/Cancel bar (bottom-right) and swallowed the next click.
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setFormError(null);
  }, [name, scopes, expiresAt]);

  const load = useCallback(async () => {
    try {
      const [g, existing] = await Promise.all([
        api.apiTokens.scopes(),
        isEdit ? api.apiTokens.list() : Promise.resolve([]),
      ]);
      setGroups(g);
      if (isEdit) {
        const t = existing.find((x) => x.id === tokenId);
        if (!t) {
          toast.error('Token not found');
          router.push('/dashboard/account/api-tokens');
          return;
        }
        if (t.status !== 'active') {
          toast.error('A revoked token can no longer be edited. Create a new token instead.');
          router.push('/dashboard/account/api-tokens');
          return;
        }
        setName(t.name);
        setScopes(new Set(t.scopes));
        setExpiresAt(t.expiresAt ? localDay(t.expiresAt) : '');
      }
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load token');
    } finally {
      setLoading(false);
    }
  }, [isEdit, tokenId, router]);

  useEffect(() => {
    load();
  }, [load]);

  // All scope strings + a category → groups map, derived once per groups change.
  const allScopes = useMemo(
    () => groups.flatMap((g) => g.scopes.map((s) => s.scope)),
    [groups],
  );
  const categories = useMemo(() => {
    const map = new Map<string, ApiTokenScopeGroup[]>();
    for (const g of groups) {
      const list = map.get(g.category) ?? [];
      list.push(g);
      map.set(g.category, list);
    }
    return Array.from(map.entries());
  }, [groups]);

  const setMany = (list: string[], on: boolean) =>
    setScopes((prev) => {
      const next = new Set(prev);
      list.forEach((s) => (on ? next.add(s) : next.delete(s)));
      return next;
    });

  const toggleOne = (s: string) =>
    setScopes((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });

  const groupScopes = (g: ApiTokenScopeGroup) => g.scopes.map((s) => s.scope);
  const categoryScopes = (gs: ApiTokenScopeGroup[]) => gs.flatMap(groupScopes);

  const allOn = allScopes.length > 0 && allScopes.every((s) => scopes.has(s));

  const save = async () => {
    if (!name.trim()) return setFormError('Give the token a name.');
    if (scopes.size === 0) return setFormError('Enable at least one scope.');
    if (expiresAt && expiresAt < todayLocal()) {
      return setFormError('The expiry date must be today or later.');
    }
    setFormError(null);
    setSaving(true);
    try {
      if (isEdit && tokenId) {
        await api.apiTokens.update(tokenId, {
          name: name.trim(),
          scopes: [...scopes],
          expiresAt: expiresAt ? endOfDayIso(expiresAt) : null,
        });
        toast.success('Token updated');
        router.push('/dashboard/account/api-tokens');
      } else {
        const res = await api.apiTokens.create({
          name: name.trim(),
          scopes: [...scopes],
          expiresAt: expiresAt ? endOfDayIso(expiresAt) : undefined,
        });
        setCreated(res);
      }
    } catch (e: any) {
      setFormError(e?.message || (isEdit ? 'Update failed' : 'Create failed'));
    } finally {
      setSaving(false);
    }
  };

  if (created) {
    return <SecretReveal token={created} onDone={() => router.push('/dashboard/account/api-tokens')} />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/dashboard/account/api-tokens')}
          className="rounded-lg p-1.5 hover:bg-accent transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <KeyRound className="h-5 w-5 text-primary" /> {isEdit ? 'Edit API token' : 'Create API token'}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isEdit
              ? 'Change the name, permissions or expiry. The token secret stays the same.'
              : 'Turn on only the permissions this token needs.'}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="token-name">Token name</Label>
        <Input
          id="token-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="orders-agent"
          className="max-w-md"
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading permissions…
        </div>
      ) : (
        <div className="space-y-4">
          {/* Master toggle */}
          <div className="flex items-center justify-between rounded-xl border bg-muted/40 px-4 py-3">
            <div>
              <p className="text-sm font-semibold">All permissions</p>
              <p className="text-xs text-muted-foreground">
                {scopes.size} of {allScopes.length} enabled
              </p>
            </div>
            <Switch checked={allOn} onCheckedChange={(on) => setMany(allScopes, on)} />
          </div>

          {categories.map(([category, gs]) => {
            const catScopes = categoryScopes(gs);
            const catAllOn = catScopes.every((s) => scopes.has(s));
            const catSome = !catAllOn && catScopes.some((s) => scopes.has(s));
            return (
              <div key={category} className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {category}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setMany(catScopes, !catAllOn)}
                    className="text-[11px] font-medium text-primary hover:underline"
                  >
                    {catAllOn ? 'Disable all' : catSome ? 'Enable rest' : 'Enable all'}
                  </button>
                </div>

                <div className="space-y-3">
                  {gs.map((g) => {
                    const gScopes = groupScopes(g);
                    const gAllOn = gScopes.every((s) => scopes.has(s));
                    return (
                      <div key={g.resource} className="rounded-xl border bg-card">
                        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{g.label}</p>
                            {g.description && (
                              <p className="truncate text-xs text-muted-foreground">{g.description}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-[11px] text-muted-foreground">All</span>
                            <Switch
                              checked={gAllOn}
                              onCheckedChange={(on) => setMany(gScopes, on)}
                            />
                          </div>
                        </div>
                        <div className="divide-y">
                          {g.scopes.map((s) => (
                            <div
                              key={s.scope}
                              className="flex items-center justify-between gap-3 px-4 py-2.5"
                            >
                              <div className="min-w-0">
                                <code className="text-xs font-medium">{s.scope}</code>
                                <p className="truncate text-xs text-muted-foreground">
                                  {s.description}
                                </p>
                              </div>
                              <Switch
                                checked={scopes.has(s.scope)}
                                onCheckedChange={() => toggleOne(s.scope)}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Expiry */}
          <div className="space-y-1.5">
            <Label htmlFor="token-exp">Expiry (optional)</Label>
            <Input
              id="token-exp"
              type="date"
              value={expiresAt}
              min={todayLocal()}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="max-w-[220px]"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty for a token that never expires. The token works until the end of the
              chosen day.
            </p>
          </div>
        </div>
      )}

      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-background/95 py-3 backdrop-blur">
        {formError ? (
          <span role="alert" className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{formError}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {scopes.size} scope{scopes.size === 1 ? '' : 's'} selected
          </span>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push('/dashboard/account/api-tokens')} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} {isEdit ? 'Save changes' : 'Create token'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SecretReveal({ token, onDone }: { token: CreatedApiToken; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(token.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-teal-500" />
        <h1 className="text-xl font-semibold">Token created</h1>
      </div>
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        This is the only time the token is shown. Copy and store it securely — you won&apos;t be
        able to see it again.
      </div>
      <div>
        <Label className="mb-1.5 block">Token “{token.name}”</Label>
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2">
          <code className="min-w-0 flex-1 break-all text-xs">{token.token}</code>
          <Button size="sm" variant="outline" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {token.scopes.map((s) => (
          <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {s}
          </span>
        ))}
      </div>
      <Button onClick={onDone}>Done</Button>
    </div>
  );
}
