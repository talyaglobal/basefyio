'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConsoleStorage, StorageCategory } from '@/lib/console-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatBytes, formatCount, formatDate, timeAgo } from '@/components/console/format';
import {
  EmptyRow,
  ErrorState,
  Meter,
  PageHeader,
  Pager,
  Panel,
  SortHeader,
  Spinner,
  StatCard,
  StatusBadge,
  td,
  tdRight,
  th,
} from '@/components/console/ui';
import { cn } from '@/lib/utils';

const CATEGORIES: Array<{ key: StorageCategory; label: string; hint: string }> = [
  { key: 'project', label: 'Live projects', hint: 'Active and paused projects' },
  { key: 'deleted_project', label: 'Deleted projects', hint: 'Left behind by deleted or deactivated projects' },
  {
    key: 'platform',
    label: 'Platform',
    hint: 'Database backups (PITR base backups and WAL), exports, imports, feedback attachments and marketing renders',
  },
  { key: 'orphan', label: 'No owner', hint: 'Matches no project at all' },
];

type SortKey = 'size' | 'objects' | 'bucket' | 'created';
const PAGE_SIZE = 50;

export default function ConsoleStoragePage() {
  const [data, setData] = useState<ConsoleStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StorageCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'size', desc: true });
  const [page, setPage] = useState(1);
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
    const list = (data?.buckets ?? []).filter((b) => {
      if (filter !== 'all' && b.category !== filter) return false;
      if (!q) return true;
      return [b.bucket, b.project?.name ?? '', b.project?.teamName ?? '', b.project?.slug ?? '']
        .some((s) => s.toLowerCase().includes(q));
    });
    const val = (b: (typeof list)[number]): number | string =>
      sort.key === 'size'
        ? b.sizeBytes
        : sort.key === 'objects'
          ? b.objectCount
          : sort.key === 'created'
            ? b.createdAt ?? ''
            : b.bucket.toLowerCase();
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.desc ? -cmp : cmp;
    });
  }, [data, filter, query, sort]);

  // Back to the first page whenever the list itself changes.
  useEffect(() => setPage(1), [filter, query, sort]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const largest = data.buckets.reduce((m, b) => Math.max(m, b.sizeBytes), 0);
  const pageCount = Math.max(1, Math.ceil(buckets.length / PAGE_SIZE));
  const visible = buckets.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const header = (label: string, key: SortKey, align: 'left' | 'right' = 'right') => (
    <SortHeader label={label} sortKey={key} sort={sort} onSort={setSort} align={align} defaultDesc={key !== 'bucket'} />
  );

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
          <button
            key={c.key}
            type="button"
            aria-pressed={filter === c.key}
            onClick={() => setFilter(filter === c.key ? 'all' : c.key)}
            className={cn('h-full rounded-lg text-left', filter === c.key && 'ring-2 ring-primary')}
          >
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
        description={`${buckets.length.toLocaleString('en-US')} buckets · ${formatBytes(buckets.reduce((s, b) => s + b.sizeBytes, 0))}`}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative w-56">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Bucket, project or team"
                aria-label="Search buckets by name, project or team"
                className="h-8 pl-8 text-sm"
              />
            </div>
            {filter !== 'all' && (
              <button type="button" onClick={() => setFilter('all')} className="text-xs font-medium text-primary hover:underline">
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
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40">
                  <tr>
                    {header('Bucket', 'bucket', 'left')}
                    <th className={th} scope="col">Owner</th>
                    {header('Objects', 'objects')}
                    {header('Size', 'size')}
                    <th className={`${th} w-32`} scope="col">
                      <span className="sr-only">Share of the largest bucket</span>
                    </th>
                    {header('Created', 'created')}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((b) => (
                    <tr key={b.bucket} className="border-b last:border-0 hover:bg-muted/40">
                      <td className={`${td} max-w-[280px] truncate font-mono text-xs`} title={b.bucket}>
                        {b.bucket}
                      </td>
                      <td className={`${td} max-w-[320px]`}>
                        {b.project ? (
                          <div className="flex min-w-0 items-center gap-2">
                            <Link
                              href={`/console/projects/${b.project.id}`}
                              prefetch={false}
                              className="truncate hover:underline"
                              title={b.project.name}
                            >
                              {b.project.name}
                            </Link>
                            {b.project.status !== 'ACTIVE' && <StatusBadge status={b.project.status} />}
                            <span className="truncate text-xs text-muted-foreground">{b.project.teamName}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            {b.category === 'platform' ? 'Platform' : 'No owning project'}
                          </span>
                        )}
                      </td>
                      <td className={tdRight}>{b.objectCount.toLocaleString('en-US')}</td>
                      <td className={`${tdRight} whitespace-nowrap font-medium`}>{formatBytes(b.sizeBytes)}</td>
                      <td className={td}>
                        <Meter value={largest ? b.sizeBytes / largest : 0} />
                      </td>
                      <td className={`${tdRight} whitespace-nowrap text-muted-foreground`}>{formatDate(b.createdAt)}</td>
                    </tr>
                  ))}
                  {buckets.length === 0 && (
                    <EmptyRow colSpan={6}>
                      {query.trim() ? `No buckets match "${query.trim()}".` : 'No buckets in this category.'}
                    </EmptyRow>
                  )}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageCount={pageCount} onPage={setPage} total={buckets.length} pageSize={PAGE_SIZE} />
          </>
        )}
      </Panel>
    </>
  );
}
