'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { PitrRecoveryWindow } from '@/lib/types';
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
import { History, Loader2, RotateCcw, TriangleAlert } from 'lucide-react';

function fmt(ts: string | null) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

/** Format an ISO instant for a `datetime-local` input, in the viewer's timezone. */
function toLocalInput(iso: string) {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/**
 * Point-in-time recovery. Unlike restoring a nightly snapshot, this rewinds the
 * database to any instant inside the retention window — so an accidental
 * `DELETE` at 14:32 can be undone by recovering to 14:31.
 */
export function ProjectPitrPanel({ projectId }: { projectId: string }) {
  const [window, setWindow] = useState<PitrRecoveryWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    try {
      const w = await api.projects.getRecoveryWindow(projectId);
      setWindow(w);
      if (w.latest) setTarget(toLocalInput(w.latest));
    } catch {
      setWindow(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const ready = !!window?.earliest;

  // Before the first physical base there is nothing to replay onto, so a target
  // that early lands on the nearest snapshot instead of the exact instant.
  const approximate =
    !!target &&
    (!window?.continuousFrom ||
      new Date(target).getTime() < new Date(window.continuousFrom).getTime());

  async function submitRestore() {
    if (confirmText.trim().toUpperCase() !== 'RESTORE') {
      toast.error('Type "RESTORE" to confirm');
      return;
    }
    setRestoring(true);
    try {
      const iso = new Date(target).toISOString();
      const res = await api.projects.restoreToTimestamp(projectId, iso);
      // The server says when it could not reach the exact instant; surfacing its
      // message keeps a snapshot restore from looking like a precise one.
      if (res.exact === false) {
        toast.warning(res.message);
      } else {
        toast.success(`Database recovered to ${new Date(res.restoredTo).toLocaleString()}`);
      }
      setConfirmOpen(false);
      setConfirmText('');
      load();
    } catch (err: any) {
      toast.error(err.message || 'Point-in-time recovery failed');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section className="rounded-xl border bg-card p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <History className="h-4 w-4 text-muted-foreground" />
            Point-in-time recovery
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Rewind this database to any instant in the retention window — not just to when a
            nightly backup ran.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading recovery window…
        </div>
      ) : !ready ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No base backup has been taken yet. The first one runs automatically tonight; recovery
          becomes available once it completes.
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Earliest</p>
              <p className="text-sm font-medium">{fmt(window!.earliest)}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Exact from
              </p>
              <p className="text-sm font-medium">
                {window!.continuousFrom ? fmt(window!.continuousFrom) : 'Not yet'}
              </p>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Latest</p>
              <p className="text-sm font-medium">{fmt(window!.latest)}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Retention</p>
              <p className="text-sm font-medium">{window!.retentionDays} days</p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pitr-target">Recover to</Label>
              <Input
                id="pitr-target"
                type="datetime-local"
                value={target}
                min={window!.earliest ? toLocalInput(window!.earliest) : undefined}
                max={window!.latest ? toLocalInput(window!.latest) : undefined}
                onChange={(e) => setTarget(e.target.value)}
                className="w-[230px]"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmText('');
                setConfirmOpen(true);
              }}
              disabled={!target}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Recover
            </Button>
          </div>

          {approximate && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              {window!.continuousFrom
                ? `Exact recovery reaches back to ${fmt(window!.continuousFrom)}. An earlier time cannot be reconstructed precisely, so the database would be restored to the nearest snapshot instead.`
                : 'No continuous backup exists yet, so the database would be restored to the nearest snapshot rather than the exact time you pick. The first one is taken tonight.'}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            {window!.baseBackupCount} base backup{window!.baseBackupCount === 1 ? '' : 's'} ·{' '}
            {window!.walSegmentCount} archived change segment
            {window!.walSegmentCount === 1 ? '' : 's'}
          </p>
        </>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-destructive" />
              Recover to an earlier state
            </DialogTitle>
            <DialogDescription>
              This replaces the current contents of the database with its state at{' '}
              <strong>{target ? new Date(target).toLocaleString() : '—'}</strong>. Anything written
              after that moment is lost. Consider exporting a backup first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pitr-confirm">
              Type <span className="font-semibold text-foreground">RESTORE</span> to confirm
            </Label>
            <Input
              id="pitr-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="RESTORE"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={restoring}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitRestore}
              disabled={restoring || confirmText.trim().toUpperCase() !== 'RESTORE'}
            >
              {restoring && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Recover database
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
