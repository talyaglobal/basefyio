'use client';

import { useCallback, useEffect, useState } from 'react';
import { HardDrive, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConsoleDisk, ConsoleDiskItem, ConsoleFilesystem } from '@/lib/console-types';
import { formatBytes, timeAgo } from '@/components/console/format';
import { Panel } from '@/components/console/ui';
import { cn } from '@/lib/utils';

const ITEM_COLORS: Record<string, string> = {
  project_databases: 'bg-primary',
  leftover_databases: 'bg-amber-500',
  platform_databases: 'bg-violet-500',
  project_files: 'bg-sky-500',
  backups: 'bg-emerald-500',
  stale_files: 'bg-orange-500',
  platform_files: 'bg-indigo-400',
  orphan_files: 'bg-rose-400',
  wal_archive: 'bg-teal-500',
  pitr_scratch: 'bg-cyan-500',
  docker_images: 'bg-zinc-500',
  docker_build_cache: 'bg-zinc-400',
  docker_containers: 'bg-zinc-300',
  other: 'bg-muted-foreground/40',
};

function levelOf(fs: ConsoleFilesystem): 'ok' | 'warn' | 'critical' {
  if (fs.usedPercent >= fs.criticalPercent) return 'critical';
  if (fs.usedPercent >= fs.warnPercent) return 'warn';
  return 'ok';
}

function FilesystemMeter({ fs }: { fs: ConsoleFilesystem }) {
  const level = levelOf(fs);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {fs.label}
            {fs.mount && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{fs.mount}</span>}
          </div>
          <div className="text-xs text-muted-foreground">{fs.note}</div>
        </div>
        {fs.available && (
          <div
            className={cn(
              'shrink-0 text-xl font-semibold tabular-nums',
              level === 'critical' && 'text-red-600 dark:text-red-400',
              level === 'warn' && 'text-amber-600 dark:text-amber-400',
            )}
          >
            {fs.usedPercent.toFixed(0)}%
          </div>
        )}
      </div>
      {fs.available ? (
        <>
          <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full',
                level === 'critical' ? 'bg-red-500' : level === 'warn' ? 'bg-amber-500' : 'bg-primary',
              )}
              style={{ width: `${Math.min(100, fs.usedPercent)}%` }}
            />
            {/* The guard's alert line. */}
            <div
              className="absolute inset-y-0 w-px bg-red-500/70"
              style={{ left: `${fs.criticalPercent}%` }}
              title={`Alert at ${fs.criticalPercent}%`}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>
              {formatBytes(fs.usedBytes)} of {formatBytes(fs.totalBytes)} used
            </span>
            <span>{formatBytes(fs.availableBytes)} free</span>
          </div>
        </>
      ) : (
        <div className="mt-2 rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">Not measured</div>
      )}
    </div>
  );
}

function Breakdown({ disk }: { disk: ConsoleDisk }) {
  const data = disk.filesystems.find((f) => f.key === 'data');
  const total = data?.available ? data.usedBytes : disk.breakdown.accountedBytes;
  const items: Array<ConsoleDiskItem & { color: string }> = disk.breakdown.items
    .filter((i) => i.bytes !== null && i.bytes > 0)
    .map((i) => ({ ...i, color: ITEM_COLORS[i.key] ?? 'bg-muted-foreground/40' }));
  if (disk.breakdown.unaccountedBytes && disk.breakdown.unaccountedBytes > 0) {
    items.push({
      key: 'other',
      label: 'Everything else',
      bytes: disk.breakdown.unaccountedBytes,
      hint: disk.docker
        ? `${disk.docker.volumes} Docker volumes not measured individually (${disk.docker.dedicatedDbVolumes} dedicated database volumes), MongoDB, Redis, Postgres WAL, logs`
        : 'Volumes, WAL, logs',
      measuredAt: null,
      color: ITEM_COLORS.other,
    });
  }
  const unreadable = disk.breakdown.items.filter((i) => i.bytes === null);

  if (disk.breakdown.pending) {
    return <p className="text-sm text-muted-foreground">Measuring what fills the volume… this takes a few seconds the first time.</p>;
  }

  return (
    <>
      {total > 0 && (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
          {items.map((i) => (
            <div key={i.key} className={i.color} style={{ width: `${((i.bytes ?? 0) / total) * 100}%` }} title={i.label} />
          ))}
        </div>
      )}
      <ul className="mt-4 space-y-2 text-sm">
        {items.map((i) => (
          <li key={i.key} className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 items-start gap-2">
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', i.color)} />
              <span className="min-w-0">
                <span>{i.label}</span>
                <span className="block text-xs text-muted-foreground">{i.hint}</span>
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatBytes(i.bytes)}
              {total > 0 && <span className="ml-1 text-xs">({(((i.bytes ?? 0) / total) * 100).toFixed(0)}%)</span>}
            </span>
          </li>
        ))}
      </ul>
      {unreadable.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Could not read: {unreadable.map((i) => i.label).join(', ')}.
        </p>
      )}
    </>
  );
}

/**
 * Host disk usage for the root console: both filesystems with the guard's
 * alert line, and what is filling the data volume.
 */
export function DiskPanel({ initial }: { initial?: ConsoleFilesystem[] }) {
  const [disk, setDisk] = useState<ConsoleDisk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.console.disk();
      setDisk(next);
      // The first breakdown may still be running; pick it up once it lands.
      if (next.breakdown.pending) setTimeout(load, 8000);
    } catch (err: any) {
      setError(err.message || 'Could not read disk usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filesystems = disk?.filesystems ?? initial ?? [];
  const worst = filesystems.filter((f) => f.available).reduce<'ok' | 'warn' | 'critical'>((acc, f) => {
    const l = levelOf(f);
    return l === 'critical' || acc === 'critical' ? 'critical' : l === 'warn' ? 'warn' : acc;
  }, 'ok');

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          Server disk
          {worst !== 'ok' && (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] font-medium',
                worst === 'critical' ? 'bg-red-500/10 text-red-700 dark:text-red-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
              )}
            >
              {worst === 'critical' ? 'Over the alert line' : 'Filling up'}
            </span>
          )}
        </span>
      }
      description={
        disk
          ? `Measured live · guard prunes build cache and old images ${disk.guard.schedule} and alerts at ${disk.guard.criticalPercent}%` +
            (disk.breakdown.measuredAt ? ` · breakdown ${timeAgo(disk.breakdown.measuredAt)}` : '')
          : 'Measured live from the host'
      }
      actions={
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          Refresh
        </button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-2">
          {filesystems.map((f) => (
            <FilesystemMeter key={f.key} fs={f} />
          ))}
          {filesystems.length === 0 && !error && <p className="text-sm text-muted-foreground">Reading filesystems…</p>}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <div className="lg:col-span-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">What fills the data volume</div>
          {disk ? <Breakdown disk={disk} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
        </div>
      </div>
    </Panel>
  );
}
