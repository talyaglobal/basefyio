'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConsoleStorage, StorageCategory } from '@/lib/console-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatBytes, formatCount, formatDate, timeAgo } from '@/components/console/format';
import {
  ErrorState,
  Meter,
  PageHeader,
  Panel,
  Spinner,
  StatCard,
  StatusBadge,
  td,
  tdRight,
  th,
  thRight,
} from '@/components/console/ui';
import { cn } from '@/lib/utils';

const PAGE = 50;

const CATEGORIES: Array<{ key: StorageCategory; label: string; hint: string }> = [
  { key: 'project', label: 'Live projects', hint: 'Active and deactivated projects' },
  { key: 'deleted_project', label: 'Deleted projects', hint: 'Left behind by deleted projects' },
  { key: 'platform', label: 'Platform', hint: 'Backups, exports, imports, feedback attachments' },
  { key: 'orphan', label: 'No owner', hint: 'Matches no project at all' },
];

export default function ConsoleStoragePage() {
  const [data, setData] = useState<ConsoleStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StorageCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api.console.storage();
      setData(next);
      // Keep polling while a full pass runs; the inventory lands when it ends.
      if (poll.current) clearTimeout(poll.current);
      if (next.refreshing) poll.current = setTimeout(load, 5000);
    } catch (err: any) {
      setError(err.message || 'Could not load storage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [load]);

  async function measure() {
    try {
      const { started } = await api.console.refreshStorage();
      toast.message(started ? 'Measuring every bucket — this can take a few minutes' : 'A measurement is already running');
      load();
    } catch (err: any) {
      toast.error(err.message || 'Could not start the measurement');
    }
  }

  const buckets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.buckets ?? []).filter(
      (b) =>
        (filter === 'all' || b.category === filter) &&
        (!q || [b.bucket, b.project?.name, b.project?.teamName].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [data, filter, query]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const largest = data.buckets[0]?.sizeBytes ?? 0;

  return (
    <>
      <PageHeader
        title="Storage"
        description={
          data.measuredAt
            ? `${formatCount(data.summary.bucketCount)} buckets · ${formatCount(data.summary.objectCount)} objects · measured ${timeAgo(data.measuredAt)} (every 6 hours)`
            : 'No full measurement yet'
        }
        actions={
          <Button variant="outline" size="sm" onClick={measure} disabled={data.refreshing}>
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', data.refreshing && 'animate-spin')} />
            {data.refreshing ? 'Measuring…' : 'Measure now'}
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {CATEGORIES.map((c) => (
          <button key={c.key} onClick={() => setFilter(filter === c.key ? 'all' : c.key)} className="h-full text-left">
            <StatCard
              label={c.label}
              value={formatBytes(data.summary.byCategory[c.key])}
              hint={c.hint}
              tone={(c.key === 'deleted_project' || c.key === 'orphan') && data.summary.byCategory[c.key] > 0 ? 'bad' : 'default'}
            />
          </button>
        ))}
      </div>

      <Panel
        className="mt-4"
        title={filter === 'all' ? 'All buckets' : CATEGORIES.find((c) => c.key === filter)?.label}
        description={`${buckets.length} buckets · ${formatBytes(buckets.reduce((s, b) => s + b.sizeBytes, 0))}`}
        actions={
          <div className="flex items-center gap-3">
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE);
              }}
              placeholder="Search bucket, project or team…"
              aria-label="Search buckets"
              className="h-8 w-60 text-sm"
            />
            {filter !== 'all' && (
              <button onClick={() => setFilter('all')} className="text-xs font-medium text-primary hover:underline">
                Show all
              </button>
            )}
          </div>
        }
        flush
      >
        {data.buckets.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            The inventory is empty until a full storage pass has run. Use “Measure now”.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className={th}>Bucket</th>
                  <th className={th}>Owner</th>
                  <th className={thRight}>Objects</th>
                  <th className={thRight}>Size</th>
                  <th className={`${th} w-32`} />
                  <th className={thRight}>Created</th>
                </tr>
              </thead>
              <tbody>
                {buckets.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No buckets match{query ? ` “${query.trim()}”` : ' this filter'}.
                    </td>
                  </tr>
                )}
                {buckets.slice(0, shown).map((b) => (
                  <tr key={b.bucket} className="border-b last:border-0 hover:bg-muted/40">
                    <td className={`${td} font-mono text-xs`}>{b.bucket}</td>
                    <td className={td}>
                      {b.project ? (
                        <div className="flex items-center gap-2">
                          <Link href={`/console/projects/${b.project.id}`} prefetch={false} className="hover:underline">
                            {b.project.name}
                          </Link>
                          {b.project.status !== 'ACTIVE' && <StatusBadge status={b.project.status} />}
                          <span className="text-xs text-muted-foreground">{b.project.teamName}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">
                          {b.category === 'platform' ? 'Platform' : 'No owning project'}
                        </span>
                      )}
                    </td>
                    <td className={tdRight}>{formatCount(b.objectCount)}</td>
                    <td className={`${tdRight} font-medium`}>{formatBytes(b.sizeBytes)}</td>
                    <td className={td}>
                      <Meter value={largest ? b.sizeBytes / largest : 0} />
                    </td>
                    <td className={`${tdRight} text-muted-foreground`}>{formatDate(b.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {buckets.length > shown && (
              <div className="border-t p-3 text-center">
                <Button variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                  Show {Math.min(PAGE, buckets.length - shown)} more ({formatCount(buckets.length - shown)} left)
                </Button>
              </div>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
