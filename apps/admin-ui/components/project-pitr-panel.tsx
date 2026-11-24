'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { PitrRecoveryWindow, PitrRestoreJob } from '@/lib/types';
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
import { CheckCircle2, Circle, History, Loader2, RotateCcw, TriangleAlert, XCircle } from 'lucide-react';
import { formatDateTime } from '@/lib/format';

function fmt(ts: string | null) {
  return ts ? formatDateTime(ts) : '—';
}

/** Format an ISO instant for a `datetime-local` input, in the viewer's timezone. */
function toLocalInput(iso: string) {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}


/** The steps a restore walks through, in order, as the dialog shows them. */
const PHASES: { key: string; label: string }[] = [
  { key: 'waiting', label: 'Waiting for a free restore slot' },
  { key: 'preparing', label: 'Checking backups and free space' },
  { key: 'downloading', label: 'Downloading the backup' },
  { key: 'replaying', label: 'Replaying changes up to your time' },
  { key: 'extracting', label: 'Extracting your database' },
  { key: 'restoring', label: 'Writing into your database' },
];

const POLL_MS = 3000;

function isActive(job: PitrRestoreJob | null) {
  return !!job && (job.status === 'queued' || job.status === 'running');
}

/** Progress, outcome or failure of one restore job. */
function RestoreProgress({ job }: { job: PitrRestoreJob }) {
  const current = PHASES.findIndex((p) => p.key === job.phase);
  const failed = job.status === 'failed';
  const done = job.status === 'succeeded';
  return (
    <div className="space-y-3" aria-live="polite">
      <ol className="space-y-1.5 text-sm">
        {PHASES.filter((p) => p.key !== 'waiting' || job.status === 'queued' || current === 0).map((p) => {
          const idx = PHASES.findIndex((x) => x.key === p.key);
          const state = done || idx < current ? 'done' : idx === current ? (failed ? 'failed' : 'current') : 'todo';
          return (
            <li key={p.key} className="flex items-center gap-2">
              {state === 'done' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : state === 'current' ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : state === 'failed' ? (
                <XCircle className="h-4 w-4 text-destructive" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground/50" />
              )}
              <span className={state === 'todo' ? 'text-muted-foreground' : ''}>{p.label}</span>
            </li>
          );
        })}
      </ol>
      {job.status === 'queued' && job.queuePosition ? (
        <p className="text-xs text-muted-foreground">
          {job.queuePosition === 1 ? 'Next in line.' : `Position ${job.queuePosition} in line.`} Restores run one at a
          time so they never slow down other databases.
        </p>
      ) : null}
      {isActive(job) && (
        <p className="text-xs text-muted-foreground">
          This usually takes several minutes. You can close this dialog; the restore continues and its status stays on
          this page.
        </p>
      )}
      {failed && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {job.message || 'The restore failed.'}
        </p>
      )}
      {done && (
        <p
          className={
            job.exact === false
              ? 'rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
              : 'rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
          }
        >
          {job.exact === false
            ? job.message
            : `Database recovered to ${job.restoredTo ? formatDateTime(job.restoredTo) : 'the requested time'}.`}
        </p>
      )}
    </div>
  );
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
  /** The restore this panel is following (started here, or found active on load). */
  const [job, setJob] = useState<PitrRestoreJob | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const announced = useRef<string | null>(null);

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

  // Pick an active restore back up after a reload or from another tab.
  useEffect(() => {
    let cancelled = false;
    api.projects
      .getPitrStatus(projectId)
      .then(({ job: latest }) => {
        if (cancelled || !latest) return;
        if (isActive(latest)) setJob(latest);
        else announced.current = latest.jobId;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Poll the job while it is queued or running. A failed poll (network, deploy)
  // keeps the last known state and tries again rather than giving up.
  const jobId = job?.jobId;
  const active = isActive(job);
  useEffect(() => {
    if (!jobId || !active) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api.projects
        .getPitrRestoreJob(projectId, jobId)
        .then((next) => {
          if (!cancelled) setJob(next);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, jobId, active]);

  // Announce the outcome once, whether or not the dialog is still open.
  useEffect(() => {
    if (!job || isActive(job) || announced.current === job.jobId) return;
    announced.current = job.jobId;
    if (job.status === 'succeeded') {
      if (job.exact === false) toast.warning(job.message || 'Restored to the nearest snapshot');
      else toast.success(`Database recovered to ${job.restoredTo ? formatDateTime(job.restoredTo) : 'the requested time'}`);
      load();
    } else if (job.status === 'failed') {
      toast.error(job.message || 'Point-in-time recovery failed');
    }
  }, [job, load]);

  const ready = !!window?.earliest;

  // Before the first physical base there is nothing to replay onto, so a target
  // that early lands on the nearest snapshot instead of the exact instant.
  const approximate =
    !!target &&
    (!window?.continuousFrom ||
      new Date(target).getTime() < new Date(window.continuousFrom).getTime());

  // Validate in the browser so an out-of-window time is explained before the request is made.
  const targetMs = target ? new Date(target).getTime() : NaN;
  const outOfWindow =
    !target || Number.isNaN(targetMs)
      ? 'Pick a date and time to recover to.'
      : window?.latest && targetMs > new Date(window.latest).getTime()
        ? `That time is after the latest recoverable moment (${fmt(window.latest)}).`
        : window?.earliest && targetMs < new Date(window.earliest).getTime()
          ? `That time is before the retention window starts (${fmt(window.earliest)}).`
          : null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function submitRestore() {
    if (outOfWindow) {
      toast.error(outOfWindow);
      return;
    }
    if (confirmText.trim().toUpperCase() !== 'RESTORE') {
      toast.error('Type "RESTORE" to confirm');
      return;
    }
    setRestoring(true);
    setStartError(null);
    try {
      const iso = new Date(target).toISOString();
      // Answers at once with a job; the dialog then follows its progress.
      const started = await api.projects.restoreToTimestamp(projectId, iso);
      setJob(started);
      setConfirmText('');
    } catch (err: any) {
      // A restore already running for this project: follow that one instead.
      const existing = err?.status === 409 ? err?.details?.jobId : null;
      if (existing) {
        try {
          setJob(await api.projects.getPitrRestoreJob(projectId, existing));
        } catch {
          /* fall through to the message */
        }
      }
      setStartError(err?.message || 'Point-in-time recovery could not be started');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section className="rounded-xl border bg-card p-6 space-y-4" data-tour="project-backup-pitr">
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

      {job && isActive(job) && !confirmOpen && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {job.status === 'queued' ? 'Restore queued' : 'Restore in progress'} — to {formatDateTime(job.targetTime)}
            {job.message ? <span className="text-muted-foreground">· {job.message}</span> : null}
          </span>
          <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
            Show progress
          </Button>
        </div>
      )}
      {job && job.status === 'failed' && !confirmOpen && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          The last restore failed: {job.message || 'no reason was recorded.'}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading recovery window…
        </div>
      ) : !ready ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No base backup has been taken yet. Base backups are taken automatically every night (they cover the whole
          cluster, so they cannot be started per project); recovery becomes available once
          the first one completes.
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
                step={1}
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
                setStartError(null);
                if (job && !isActive(job)) setJob(null);
                setConfirmOpen(true);
              }}
              disabled={!!outOfWindow || isActive(job)}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Recover
            </Button>
          </div>

          {outOfWindow && target && (
            <p role="alert" className="text-xs text-destructive">{outOfWindow}</p>
          )}

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
              {job ? (
                <History className="h-4 w-4 text-muted-foreground" />
              ) : (
                <TriangleAlert className="h-4 w-4 text-destructive" />
              )}
              {job ? 'Point-in-time recovery' : 'Recover to an earlier state'}
            </DialogTitle>
            <DialogDescription>
              {job ? (
                <>
                  Recovering to <strong>{formatDateTime(job.targetTime)}</strong> ({timeZone}).
                </>
              ) : (
                <>
                  This replaces the current contents of the database with its state at{' '}
                  <strong>{target ? formatDateTime(target) : '—'}</strong> ({timeZone}). Anything written
                  after that moment is lost. Consider exporting a backup first.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {job ? (
            <RestoreProgress job={job} />
          ) : (
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
          )}
          {startError && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {startError}
            </p>
          )}
          <DialogFooter>
            {job ? (
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                {isActive(job) ? 'Close (keeps running)' : 'Close'}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={restoring}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={submitRestore}
                  disabled={restoring || !!outOfWindow || confirmText.trim().toUpperCase() !== 'RESTORE'}
                >
                  {restoring && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Recover database
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
