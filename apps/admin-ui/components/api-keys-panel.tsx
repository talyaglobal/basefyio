'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ProjectApiKeys } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Check, Copy, Eye, KeyRound, Plus, RotateCcw, Trash2 } from 'lucide-react';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`${what} copied`);
}

/**
 * The project's server keys. The service_role key is masked; it can be revealed and copied
 * until an application first uses it, then it stays hidden — rotate it or create a secret key
 * for a new server. Secret keys are shown once, when they are created.
 */
export function ApiKeysPanel({ projectId, onKeysChanged }: { projectId: string; onKeysChanged?: () => void }) {
  const [keys, setKeys] = useState<ProjectApiKeys | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [shownOnce, setShownOnce] = useState<{ title: string; key: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys(await api.projects.apiKeys(projectId));
    } catch (err: any) {
      toast.error(err?.message || 'Could not load the API keys');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reveal() {
    setBusy(true);
    try {
      setRevealed((await api.projects.revealServiceKey(projectId)).serviceKey);
    } catch (err: any) {
      toast.error(err?.message || 'The key cannot be shown');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function rotateAnon() {
    const ok = await confirmDialog({
      title: 'Rotate the anon key',
      description:
        'A new anon key is created and the current one stops working immediately. Every web or mobile app that ships the current key will be refused until it is rebuilt or redeployed with the new one. Server keys are not affected.',
      confirmText: 'Rotate',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.projects.rotateAnonKey(projectId);
      toast.success('Anon key rotated — update your apps with the new key');
      await load();
      onKeysChanged?.();
    } catch (err: any) {
      toast.error(err?.message || 'Rotation failed');
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    const ok = await confirmDialog({
      title: 'Rotate the service key',
      description:
        'A new service key is created and the current one stops working immediately. Every server that still uses the current key will be refused until you give it the new one. Secret keys are not affected.',
      confirmText: 'Rotate',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { serviceKey } = await api.projects.rotateServiceKey(projectId);
      setRevealed(null);
      setShownOnce({ title: 'New service key', key: serviceKey });
      await load();
      onKeysChanged?.();
    } catch (err: any) {
      toast.error(err?.message || 'Rotation failed');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    try {
      const created = await api.projects.createSecretKey(projectId, newName.trim());
      setCreating(false);
      setNewName('');
      setShownOnce({ title: `Secret key “${created.name}”`, key: created.key });
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not create the key');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string, name: string) {
    const ok = await confirmDialog({
      title: 'Revoke secret key',
      description: `Requests with “${name}” are refused from now on. This cannot be undone.`,
      confirmText: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.projects.revokeSecretKey(projectId, id);
      toast.success('Key revoked');
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not revoke the key');
    }
  }

  if (!keys) {
    return <div className="h-24 animate-pulse rounded-md border bg-muted/30" />;
  }

  return (
    <div className="space-y-4">
      {/* anon key: public, always shown */}
      <div className="rounded-md border p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Anon key (public)</p>
            <p className="text-xs text-muted-foreground">Safe in browsers and apps; row-level security decides what it can read.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => copy(keys.anonKey, 'Anon key')}>
              <Copy className="mr-1 h-4 w-4" /> Copy
            </Button>
            {keys.canManage && (
              <Button variant="outline" size="sm" onClick={rotateAnon} disabled={busy}>
                <RotateCcw className="mr-1 h-4 w-4" /> Rotate
              </Button>
            )}
          </div>
        </div>
        <code className="block truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">{keys.anonKey}</code>
      </div>

      {/* service_role key */}
      <div className="rounded-md border p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Service key (secret, full access)</p>
            <p className="text-xs text-muted-foreground">Last used: {when(keys.serviceKey.lastUsedAt)}</p>
          </div>
          <div className="flex gap-2">
            {keys.serviceKey.revealable && !revealed && (
              <Button variant="outline" size="sm" onClick={reveal} disabled={busy}>
                <Eye className="mr-1 h-4 w-4" /> Reveal
              </Button>
            )}
            {revealed && (
              <Button variant="outline" size="sm" onClick={() => copy(revealed, 'Service key')}>
                <Copy className="mr-1 h-4 w-4" /> Copy
              </Button>
            )}
            {keys.canManage && (
              <Button variant="outline" size="sm" onClick={rotate} disabled={busy}>
                <RotateCcw className="mr-1 h-4 w-4" /> Rotate
              </Button>
            )}
          </div>
        </div>
        <code className="block truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
          {revealed ?? keys.serviceKey.masked}
        </code>
        {!keys.serviceKey.revealable && (
          <p className="mt-2 text-xs text-muted-foreground">
            This key is in use by an application, so it is no longer shown here. For a new server, create a secret key
            below, or rotate this one.
          </p>
        )}
      </div>

      {/* secret keys */}
      <div className="rounded-md border p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Secret keys</p>
            <p className="text-xs text-muted-foreground">
              Same rights as the service key. Shown once when created; revoke one without touching the others.
            </p>
          </div>
          {keys.canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" /> New secret key
            </Button>
          )}
        </div>
        {keys.secretKeys.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">No secret keys yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {keys.secretKeys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{k.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{k.hint}</p>
                  <p className="text-xs text-muted-foreground">
                    Created {when(k.createdAt)} · last used {when(k.lastUsedAt)}
                  </p>
                </div>
                {keys.canManage && (
                  <Button variant="ghost" size="sm" onClick={() => revoke(k.id, k.name)} aria-label={`Revoke ${k.name}`}>
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!keys.canManage && (
          <p className="mt-2 text-xs text-muted-foreground">
            Rotating and creating keys needs the team&apos;s credentials permission.
          </p>
        )}
      </div>

      {/* new secret key: name */}
      <Dialog open={creating} onOpenChange={(open) => !busy && setCreating(open)}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-md">
          <DialogTitle>New secret key</DialogTitle>
          <p className="text-sm text-muted-foreground">Name it after where it will be used, e.g. “production server”.</p>
          <Input
            autoFocus
            value={newName}
            maxLength={60}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && newName.trim() && void create()}
            placeholder="Key name"
            aria-label="Key name"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={create} disabled={busy || !newName.trim()}>
              <KeyRound className="mr-1 h-4 w-4" /> Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* a key shown exactly once */}
      <ShownOnceDialog value={shownOnce} onClose={() => setShownOnce(null)} />
    </div>
  );
}

function ShownOnceDialog({ value, onClose }: { value: { title: string; key: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [value]);
  return (
    <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogTitle>{value?.title}</DialogTitle>
        <p className="text-sm text-muted-foreground">
          Copy it now and store it on your server. It will not be shown again.
        </p>
        <code className="block break-all rounded bg-muted px-2 py-2 font-mono text-xs">{value?.key}</code>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={async () => {
              if (!value) return;
              await copy(value.key, 'Key');
              setCopied(true);
            }}
          >
            {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
