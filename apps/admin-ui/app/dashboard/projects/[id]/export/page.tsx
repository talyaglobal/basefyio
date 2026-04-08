'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Download, Loader2, Minimize2, PackageCheck, Play } from 'lucide-react';
import { api } from '@/lib/api';
import type { CloudBackupItem, ExportJobProgressEvent, ExportJobResult } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useExportProgress } from '@/lib/export-progress-context';

export default function ProjectExportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const {
    activeExports,
    startTracking,
    dismiss,
    setModalShowingExport,
    setOnReopenModal,
  } = useExportProgress();
  const [starting, setStarting] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [waitingWarning, setWaitingWarning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [cloudBackups, setCloudBackups] = useState<CloudBackupItem[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [options, setOptions] = useState({
    includeDatabase: true,
    includeAuth: true,
    includeStorage: true,
    includeConfig: true,
  });

  const currentProjectExports = useMemo(
    () => activeExports.filter((x) => x.projectId === id),
    [activeExports, id],
  );
  const queuedExports = useMemo(
    () => activeExports.filter((x) => x.status === 'running'),
    [activeExports],
  );
  const selectedExport = useMemo(
    () =>
      currentProjectExports.find((x) => x.jobId === selectedJobId) ||
      currentProjectExports[0] ||
      null,
    [currentProjectExports, selectedJobId],
  );
  const progress = selectedExport?.progress ?? null;
  const failed = selectedExport?.status === 'failed' ? selectedExport.error || 'Export failed' : null;
  const result = selectedExport?.result ?? null;
  const jobState = selectedExport?.state ?? null;

  const progressPercent = useMemo(
    () => Math.max(0, Math.min(100, progress?.percent ?? 0)),
    [progress?.percent],
  );

  async function handleStartExport() {
    if (!options.includeDatabase && !options.includeAuth && !options.includeStorage && !options.includeConfig) {
      toast.error('Select at least one export section');
      return;
    }
    setStarting(true);
    try {
      const projectInfo = await api.projects.get(id).catch(() => null);
      const res = await api.projects.startExport(id, options);
      startTracking(
        res.jobId,
        id,
        projectInfo?.name || `Project ${id.slice(0, 8)}`,
        () => {
          void loadCloudBackups();
        },
      );
      setSelectedJobId(res.jobId);
      setExportModalOpen(true);
      setModalShowingExport(true);
      toast.success('Export started');
    } catch (err: any) {
      toast.error(err.message || 'Failed to start export');
    } finally {
      setStarting(false);
    }
  }

  async function handleDownload() {
    if (!selectedExport?.jobId) return;
    setDownloading(true);
    try {
      const { blob, filename } = await api.projects.downloadExport(id, selectedExport.jobId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Download started');
    } catch (err: any) {
      toast.error(err.message || 'Failed to download export');
    } finally {
      setDownloading(false);
    }
  }

  async function loadCloudBackups() {
    setLoadingBackups(true);
    try {
      const backups = await api.projects.listCloudBackups(id);
      setCloudBackups(backups);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load cloud backups');
    } finally {
      setLoadingBackups(false);
    }
  }

  async function handleRestoreFromCloud(objectKey: string) {
    setRestoringKey(objectKey);
    try {
      const { teamId } = await api.teams.getActive();
      const result = await api.projects.restoreCloudBackup(id, {
        objectKey,
        teamId,
        nameMode: 'existing',
      });
      toast.success(`Backup restored: ${result.project.name}`);
      router.push(`/dashboard/projects/${result.project.id}`);
    } catch (err: any) {
      toast.error(err.message || 'Cloud restore failed');
    } finally {
      setRestoringKey(null);
    }
  }

  useEffect(() => {
    loadCloudBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!selectedExport) return;
    setWaitingWarning(false);
    if (selectedExport.state !== 'waiting' && selectedExport.state !== 'delayed') return;
    const timer = setTimeout(() => setWaitingWarning(true), 20_000);
    return () => clearTimeout(timer);
  }, [selectedExport?.jobId, selectedExport?.state]);

  useEffect(() => {
    const reopen = () => {
      const current = activeExports.find((x) => x.projectId === id && x.status === 'running');
      if (current) {
        setSelectedJobId(current.jobId);
        setExportModalOpen(true);
        setModalShowingExport(true);
      }
    };
    setOnReopenModal(reopen);
    return () => setOnReopenModal(null);
  }, [activeExports, id, setModalShowingExport, setOnReopenModal]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Backup & Export</h1>
          <p className="text-sm text-muted-foreground">
            Download a full backup package including database, auth, storage, and config.
          </p>
        </div>
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>

      <section className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="text-base font-semibold">Export options</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ['includeDatabase', 'Database (pg_dump)'],
            ['includeAuth', 'Auth users and realm'],
            ['includeStorage', 'Storage buckets and objects'],
            ['includeConfig', 'Project metadata and config'],
          ].map(([key, label]) => (
            <label
              key={key}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm hover:bg-accent/55 dark:hover:bg-accent/30 transition-colors"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={options[key as keyof typeof options]}
                onChange={(e) =>
                  setOptions((prev) => ({
                    ...prev,
                    [key]: e.target.checked,
                  }))
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <Button onClick={handleStartExport} disabled={starting}>
          {starting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          {starting ? 'Starting...' : 'Start Export'}
        </Button>
      </section>

      {queuedExports.length > 0 && (
        <section className="rounded-xl border bg-card p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Active export queue</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (selectedExport?.jobId) setSelectedJobId(selectedExport.jobId);
                else if (queuedExports[0]) setSelectedJobId(queuedExports[0].jobId);
                setExportModalOpen(true);
                setModalShowingExport(true);
              }}
            >
              Open Status Modal
            </Button>
          </div>
          <div className="space-y-2">
            {queuedExports.map((q) => (
              <button
                key={q.jobId}
                type="button"
                className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left hover:bg-accent"
                onClick={() => {
                  setSelectedJobId(q.jobId);
                  setExportModalOpen(true);
                  setModalShowingExport(true);
                }}
              >
                <span className="truncate text-sm font-medium">{q.projectName}</span>
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {q.progress?.percent ?? 0}%
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Cloud Backups & Restore</h2>
          <Button variant="outline" size="sm" onClick={loadCloudBackups} disabled={loadingBackups}>
            {loadingBackups ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
          </Button>
        </div>
        <div className="space-y-2">
          {cloudBackups.length === 0 && (
            <p className="text-sm text-muted-foreground">No cloud backups found for this project.</p>
          )}
          {cloudBackups.map((b) => (
            <div key={b.objectKey} className="flex items-center justify-between rounded-lg border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{b.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {(b.size / 1024 / 1024).toFixed(2)} MB • {new Date(b.lastModified).toLocaleString()}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => handleRestoreFromCloud(b.objectKey)}
                disabled={restoringKey === b.objectKey}
              >
                {restoringKey === b.objectKey ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Restoring...
                  </>
                ) : (
                  'Restore'
                )}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <Dialog
        open={exportModalOpen}
        onOpenChange={(open) => {
          setExportModalOpen(open);
          setModalShowingExport(open);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <DialogTitle>Export Status</DialogTitle>
                <DialogDescription>
                  Track running exports. You can minimize and reopen anytime.
                </DialogDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => {
                  setExportModalOpen(false);
                  setModalShowingExport(false);
                }}
                title="Minimize"
              >
                <Minimize2 className="h-4 w-4" />
              </Button>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            {queuedExports.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">Queue Projects</p>
                <div className="space-y-1.5">
                  {queuedExports.map((q) => (
                    <button
                      key={q.jobId}
                      type="button"
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                        selectedExport?.jobId === q.jobId ? 'border-primary bg-primary/5' : 'hover:bg-accent'
                      }`}
                      onClick={() => setSelectedJobId(q.jobId)}
                    >
                      <span className="truncate font-medium">{q.projectName}</span>
                      <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                        {q.progress?.percent ?? 0}%
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedExport && (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{selectedExport.projectName}</p>
                  <p className="text-xs text-muted-foreground">State: {jobState || 'waiting'}</p>
                </div>

                {waitingWarning && (jobState === 'waiting' || jobState === 'delayed') && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
                    Export is still waiting in queue. Worker may be busy or unavailable.
                  </div>
                )}
                {failed && (
                  <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800">
                    Export failed: {failed}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {failed || progress?.detail || 'Waiting...'}
                    </span>
                    <span className="font-medium tabular-nums">{progressPercent}%</span>
                  </div>
                </div>

                {result && (
                  <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <PackageCheck className="h-4 w-4 text-emerald-600" />
                      <span>Archive ready: {result.filename}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button onClick={handleDownload} disabled={downloading}>
                        {downloading ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="mr-2 h-4 w-4" />
                        )}
                        {downloading ? 'Preparing...' : 'Download ZIP'}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => dismiss(selectedExport.jobId)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
