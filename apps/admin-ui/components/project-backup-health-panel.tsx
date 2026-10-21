'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, CloudOff, CloudUpload, Loader2, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import type { BackupHealth, BackupVerification } from '@/lib/types';
import { Button } from '@/components/ui/button';

function fmt(ts: string | null | undefined) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function fmtDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

const STATUS_STYLE: Record<BackupVerification['status'], string> = {
  PASSED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  FAILED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  SKIPPED: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  RUNNING: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
};

export function VerificationStatusChip({ status }: { status: BackupVerification['status'] }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[status]}`}
    >
      {status === 'RUNNING' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'PASSED' && <CheckCircle2 className="h-3 w-3" />}
      {status === 'FAILED' && <XCircle className="h-3 w-3" />}
      {status === 'SKIPPED' && <TriangleAlert className="h-3 w-3" />}
      {status === 'PASSED' ? 'Verified' : status === 'FAILED' ? 'Verification failed' : status.toLowerCase()}
    </span>
  );
}

/**
 * Whether the backups of this project exist somewhere other than this host,
 * and whether the newest one has actually been proven restorable. The nightly
 * archive list says a file exists; this card says what it is worth.
 */
export function ProjectBackupHealthPanel({
  projectId,
  health,
  loading,
  onRefresh,
}: {
  projectId: string;
  health: BackupHealth | null;
  loading: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const [verifying, setVerifying] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const latest = health?.verification.latest ?? null;
  const running = verifying || health?.verification.running || latest?.status === 'RUNNING';
  const offsite = health?.offsite;
  const copiesUploaded = offsite ? Object.values(offsite.copies).filter((c) => c.status === 'UPLOADED').length : 0;

  async function verifyNow() {
    setVerifying(true);
    try {
      await api.projects.verifyBackup(projectId);
      toast.success('Restore verification started — the verdict appears here when the drill finishes');
      // The drill takes seconds for a small project and minutes for a large one;
      // poll until the newest row leaves RUNNING, then hand the result back.
      for (let i = 0; i < 120 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, i < 24 ? 5000 : 15000));
        const h = await api.projects.backupHealth(projectId).catch(() => null);
        const row = h?.verification.latest;
        if (row && row.status !== 'RUNNING') {
          if (row.status === 'PASSED') toast.success('Backup restored cleanly in a throwaway database');
          else if (row.status === 'FAILED') toast.error(`Restore verification failed: ${row.error ?? 'see details'}`);
          else toast.message(`Restore verification skipped: ${row.error ?? ''}`);
          break;
        }
      }
      if (alive.current) await onRefresh();
    } catch (err: any) {
      toast.error(err?.message || 'Could not start the restore verification');
    } finally {
      if (alive.current) setVerifying(false);
    }
  }

  return (
    <section className="rounded-xl border bg-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Backup health</h2>
          <p className="text-xs text-muted-foreground">
            Where the backups are kept, and whether the newest one has been proven to restore.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void onRefresh()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
        </Button>
      </div>

      {/* Off-site copies */}
      <div className="flex items-start gap-3 rounded-lg border p-3 text-sm">
        {offsite?.enabled ? (
          <CloudUpload className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        ) : offsite?.misconfigured ? (
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        ) : (
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          {offsite?.enabled ? (
            <>
              <p className="font-medium">
                Off-site copies: enabled
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {offsite.endpoint}/{offsite.bucket} · {offsite.encrypted ? 'encrypted' : 'not encrypted'}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {copiesUploaded} archive{copiesUploaded === 1 ? '' : 's'} of this project copied off this server.
              </p>
            </>
          ) : offsite?.misconfigured ? (
            <>
              <p className="font-medium text-amber-700 dark:text-amber-300">Off-site copies are configured but not running</p>
              <p className="text-xs text-muted-foreground">{offsite.reason}</p>
            </>
          ) : (
            <>
              <p className="font-medium">Off-site copies: not configured</p>
              <p className="text-xs text-muted-foreground">
                Backups live only on this server. An operator can set BACKUP_S3_* and BACKUP_ENC_KEY on the API to copy
                every nightly archive, encrypted, to a bucket elsewhere.
              </p>
            </>
          )}
          {health?.localEncryption && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <ShieldCheck className="h-3 w-3" /> Nightly archives are encrypted at rest on this server too.
            </p>
          )}
        </div>
      </div>

      {/* Restore verification */}
      <div className="rounded-lg border p-3 text-sm space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <p className="font-medium">Restore verification</p>
            {latest ? <VerificationStatusChip status={latest.status} /> : (
              <span className="text-xs text-muted-foreground">never run for this project</span>
            )}
          </div>
          <Button size="sm" onClick={() => void verifyNow()} disabled={!!running || loading}>
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying…
              </>
            ) : (
              'Verify now'
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The newest nightly archive is rebuilt into a throwaway database on the cluster, its tables are counted and
          compared with the counts taken when the backup was made, and the database is dropped again.{' '}
          {health && (health.verification.enabled ? 'Runs every Sunday at 05:00 UTC.' : 'The weekly run is switched off.')}
        </p>
        {latest && latest.status !== 'RUNNING' && (
          <div className="grid gap-1 text-xs sm:grid-cols-2">
            <span>
              <span className="text-muted-foreground">Finished:</span> {fmt(latest.finishedAt)} ({fmtDuration(latest.durationMs)})
            </span>
            <span>
              <span className="text-muted-foreground">Archive:</span> {latest.backupObjectKey?.split('/').pop() ?? '—'}
            </span>
            <span>
              <span className="text-muted-foreground">Tables restored:</span> {latest.tablesRestored ?? '—'}
              {latest.tablesExpected != null && ` of ${latest.tablesExpected}`}
            </span>
            <span>
              <span className="text-muted-foreground">Row counts:</span>{' '}
              {latest.countsCompared
                ? `${latest.details?.compared ?? 0} compared, ${latest.rowsMismatched ?? 0} mismatched`
                : 'not recorded in this archive'}
            </span>
            {latest.psqlErrorCount != null && latest.psqlErrorCount > 0 && (
              <span className="text-red-700 dark:text-red-300">{latest.psqlErrorCount} psql error(s) during replay</span>
            )}
            {latest.error && latest.status !== 'PASSED' && (
              <span className="sm:col-span-2 text-amber-800 dark:text-amber-300">{latest.error}</span>
            )}
          </div>
        )}
        {health && health.verifications.length > 1 && (
          <button
            type="button"
            className="text-xs text-primary underline-offset-2 hover:underline"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            {historyOpen ? 'Hide history' : `Show history (${health.verifications.length})`}
          </button>
        )}
        {historyOpen && health && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Started</th>
                  <th className="py-1 pr-3 font-medium">Trigger</th>
                  <th className="py-1 pr-3 font-medium">Verdict</th>
                  <th className="py-1 pr-3 font-medium">Tables</th>
                  <th className="py-1 pr-3 font-medium">Mismatches</th>
                  <th className="py-1 pr-3 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {health.verifications.map((v) => (
                  <tr key={v.id} className="border-t">
                    <td className="py-1 pr-3 whitespace-nowrap">{fmt(v.startedAt)}</td>
                    <td className="py-1 pr-3">{v.trigger}</td>
                    <td className="py-1 pr-3">
                      <VerificationStatusChip status={v.status} />
                    </td>
                    <td className="py-1 pr-3">{v.tablesRestored ?? '—'}</td>
                    <td className="py-1 pr-3">{v.countsCompared ? v.rowsMismatched ?? 0 : '—'}</td>
                    <td className="py-1 pr-3">{fmtDuration(v.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
