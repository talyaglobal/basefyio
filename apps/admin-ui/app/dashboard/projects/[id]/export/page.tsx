'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Download, Loader2, PackageCheck, Play } from 'lucide-react';
import { api } from '@/lib/api';
import type { CloudBackupItem, ExportJobProgressEvent, ExportJobResult } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function ProjectExportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportJobProgressEvent | null>(null);
  const [result, setResult] = useState<ExportJobResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [cloudBackups, setCloudBackups] = useState<CloudBackupItem[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [nameMode, setNameMode] = useState<'existing' | 'new'>('existing');
  const [newProjectName, setNewProjectName] = useState('');
  const [options, setOptions] = useState({
    includeDatabase: true,
    includeAuth: true,
    includeStorage: true,
    includeConfig: true,
  });

  useEffect(() => {
    if (!jobId) return;
    const es = api.projects.streamExportProgress(id, jobId, {
      onProgress: (data) => setProgress(data),
      onCompleted: (data) => {
        setResult(data);
        setProgress({ step: 'completed', detail: 'Export completed', percent: 100 });
        toast.success('Export ready for download');
      },
      onFailed: (error) => {
        setFailed(error);
        toast.error(error);
      },
      onError: () => {
        setFailed('Export stream disconnected');
      },
    });

    return () => es.close();
  }, [id, jobId]);

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
    setFailed(null);
    setResult(null);
    setProgress(null);
    try {
      const res = await api.projects.startExport(id, options);
      setJobId(res.jobId);
      toast.success('Export started');
    } catch (err: any) {
      toast.error(err.message || 'Failed to start export');
    } finally {
      setStarting(false);
    }
  }

  async function handleDownload() {
    if (!jobId) return;
    setDownloading(true);
    try {
      const { blob, filename } = await api.projects.downloadExport(id, jobId);
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
    if (nameMode === 'new' && !newProjectName.trim()) {
      toast.error('Please enter a new project name');
      return;
    }
    setRestoringKey(objectKey);
    try {
      const { teamId } = await api.teams.getActive();
      const result = await api.projects.restoreCloudBackup(id, {
        objectKey,
        teamId,
        nameMode,
        newProjectName: nameMode === 'new' ? newProjectName.trim() : undefined,
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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Export Project</h1>
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

      {(progress || failed || result) && (
        <section className="rounded-xl border bg-card p-6 space-y-4">
          <h2 className="text-base font-semibold">Export progress</h2>
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
              <Button onClick={handleDownload} disabled={downloading}>
                {downloading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {downloading ? 'Preparing...' : 'Download ZIP'}
              </Button>
            </div>
          )}
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
          <p className="text-sm font-medium">Restore name option</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" className="h-4 w-4 accent-primary" checked={nameMode === 'existing'} onChange={() => setNameMode('existing')} />
            Use exported project name
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" className="h-4 w-4 accent-primary" checked={nameMode === 'new'} onChange={() => setNameMode('new')} />
            Use new project name
          </label>
          {nameMode === 'new' && (
            <Input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="new-project-name"
              maxLength={64}
            />
          )}
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
    </div>
  );
}
