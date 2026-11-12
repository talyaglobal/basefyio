'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Camera, History, Loader2, RotateCcw, TriangleAlert } from 'lucide-react';

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
  const [snapshotting, setSnapshotting] = useState(false);
  const alive = useRef(true);
  /** The picker is pre-filled once; later reloads must not overwrite what the user chose. */
  const targetTouched = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const w = await api.projects.getRecoveryWindow(projectId);
      if (!alive.current) return null;
      setWindow(w);
      if (w.latest && !targetTouched.current) setTarget(toLocalInput(w.latest));
      return w;
    } catch {
      if (alive.current) setWindow(null);
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const ready = !!window?.earliest;

  // Check the chosen time here instead of leaving every mistake to the server.
  const targetError = useMemo(() => {
    if (!target || !window) return null;
    const t = new Date(target).getTime();
    if (Number.isNaN(t)) return 'Enter a valid date and time.';
    if (t > Date.now()) return 'That time is in the future.';
    if (window.earliest && t < new Date(window.earliest).getTime() - 60_000) {
      return `The earliest recoverable time is ${fmt(window.earliest)} (snapshots are kept ${window.retentionDays} days).`;
    }
    if (window.latest && t > new Date(window.latest).getTime() + 60_000) {
      return `Changes after ${fmt(window.latest)} are not archived yet. Pick that time or earlier.`;
    }
    return null;
  }, [target, window]);

  // Before the first physical base there is nothing to replay onto, so a target
  // that early lands on the nearest snapshot instead of the exact instant.
  const approximate =
    !!target &&
    !targetError &&
    (!window?.continuousFrom ||
      new Date(target).getTime() < new Date(window.continuousFrom).getTime());

  async function takeSnapshot() {
    setSnapshotting(true);
    try {
      const res = await api.projects.takePitrSnapshot(projectId);
      toast.success(res.message);
      // A snapshot of a small project takes seconds, a large one minutes.
      // Follow it for up to five minutes, then leave the rest to Refresh.
      for (let i = 0; i < 60 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const w = await load();
        if (w && !w.snapshotRunning) {
          if (w.earliest) toast.success('Snapshot taken. Recovery is available.');
          break;
        }
      }
    } catch (err: any) {
      toast.error(err.message || 'Could not take a snapshot');
    } finally {
      if (alive.current) setSnapshotting(false);
    }
  }

  async function submitRestore() {
    if (confirmText.trim().toUpperCase() !== 'RESTORE') {
      toast.error('Type "RESTORE" to confirm');
      return;
    }
    if (targetError) {
      toast.error(targetError);
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

  const snapshotBusy = snapshotting || !!window?.snapshotRunning;

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
        {ready && (
          <Button variant="outline" size="sm" onClick={() => void takeSnapshot()} disabled={snapshotBusy}>
            {snapshotBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
            Snapshot now
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading recovery window…
        </div>
      ) : !ready ? (
        <div className="space-y-3 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          <p>
            No snapshot of this project exists yet, so there is nothing to recover to. The nightly run takes
            one at 02:00 UTC — or take one now; recovery becomes available as soon as it finishes.
          </p>
          <Button size="sm" onClick={() => void takeSnapshot()} disabled={snapshotBusy}>
            {snapshotBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
            {snapshotBusy ? 'Taking snapshot…' : 'Take a snapshot now'}
          </Button>
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
                onChange={(e) => {
                  targetTouched.current = true;
                  setTarget(e.target.value);
                }}
                aria-invalid={!!targetError}
                aria-describedby="pitr-target-error"
                className="w-[230px]"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmText('');
                setConfirmOpen(true);
              }}
              disabled={!target || !!targetError}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Recover
            </Button>
          </div>

          {targetError && (
            <p id="pitr-target-error" className="text-xs text-red-600 dark:text-red-400">
              {targetError}
            </p>
          )}

          {approximate && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              {window!.continuousFrom
                ? `Exact recovery reaches back to ${fmt(window!.continuousFrom)}. An earlier time cannot be reconstructed precisely, so the database would be restored to the nearest snapshot instead.`
                : 'No continuous backup exists yet, so the database would be restored to the nearest snapshot rather than the exact time you pick. The first one is taken tonight.'}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Snapshots of this project are kept {window!.retentionDays} days ({window!.baseBackupCount} now).
            {window!.clusterBaseRetain
              ? ` Exact, to-the-second recovery reaches back to the oldest of the last ${window!.clusterBaseRetain} daily full backups (${window!.clusterBaseCount ?? 0} held now); earlier times restore the nearest snapshot.`
              : ''}{' '}
            {window!.walSegmentCount} archived change segment{window!.walSegmentCount === 1 ? '' : 's'}.
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
              disabled={restoring || confirmText.trim().toUpperCase() !== 'RESTORE' || !!targetError}
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
