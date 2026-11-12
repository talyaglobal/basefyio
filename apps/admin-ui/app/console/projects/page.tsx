'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, RefreshCw, Search } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConsoleProjectList, ConsoleProjectRow } from '@/lib/console-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatBytes, formatCount, formatDate, formatUsd, timeAgo } from '@/components/console/format';
import {
  EmptyRow,
  ErrorState,
  FilterChips,
  PageHeader,
  Panel,
  SortHeader,
  Spinner,
  StatusBadge,
  th,
} from '@/components/console/ui';
import { cn } from '@/lib/utils';

type SortKey = 'name' | 'created' | 'db' | 'storage' | 'total' | 'buckets' | 'api' | 'egress' | 'cost' | 'price';

const SORTERS: Record<SortKey, (p: ConsoleProjectRow) => number | string> = {
  name: (p) => p.name.toLowerCase(),
  created: (p) => p.createdAt,
  db: (p) => p.dbSizeBytes,
  storage: (p) => p.storageBytes,
  total: (p) => p.dbSizeBytes + p.storageBytes,
  buckets: (p) => p.bucketCount ?? -1,
  api: (p) => p.apiRequests,
  egress: (p) => p.bandwidthBytes,
  cost: (p) => p.cost?.projectedRawUsd ?? -1,
  price: (p) => p.cost?.projectedPricedUsd ?? -1,
};

const STATUSES = ['ALL', 'ACTIVE', 'PAUSED', 'DEACTIVATED', 'DELETED'] as const;
type Status = (typeof STATUSES)[number];
const STATUS_LABELS: Record<Status, string> = {
  ALL: 'All',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  DEACTIVATED: 'Deactivated',
  DELETED: 'In trash',
};

// Tighter cells than the console default: ten columns have to fit next to the sidebar.
const cell = 'px-2 py-2 align-middle';
const cellRight = `${cell} whitespace-nowrap text-right tabular-nums`;

export default function ConsoleProjectsPage() {
  const [data, setData] = useState<ConsoleProjectList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('ALL');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cost', desc: true });

  const includeDeleted = status === 'DELETED';
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.console.projects(includeDeleted));
    } catch (err: any) {
      setError(err.message || 'Could not load projects');
    } finally {
      setLoading(false);
    }
  }, [includeDeleted]);

  useEffect(() => {
    load();
  }, [load]);

  // Links from elsewhere in the console (a team in the plan mix) arrive with ?q=.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) setQuery(q);
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const filtered = data.projects.filter((p) => {
      if (status !== 'ALL' && p.status !== status) return false;
      if (!q) return true;
      return [p.name, p.slug, p.team.name, p.owner?.email ?? '', p.owner?.name ?? '']
        .some((s) => s.toLowerCase().includes(q));
    });
    const key = SORTERS[sort.key];
    return filtered.sort((a, b) => {
      const va = key(a);
      const vb = key(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.desc ? -cmp : cmp;
    });
  }, [data, query, status, sort]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (t, p) => ({
          db: t.db + p.dbSizeBytes,
          storage: t.storage + p.storageBytes,
          buckets: t.buckets + (p.bucketCount ?? 0),
          api: t.api + p.apiRequests,
          egress: t.egress + p.bandwidthBytes,
          cost: t.cost + (p.cost?.projectedRawUsd ?? 0),
          price: t.price + (p.cost?.projectedPricedUsd ?? 0),
        }),
        { db: 0, storage: 0, buckets: 0, api: 0, egress: 0, cost: 0, price: 0 },
      ),
    [rows],
  );

  const header = (label: string, key: SortKey, align: 'left' | 'right' = 'right', className?: string) => (
    <SortHeader
      label={label}
      sortKey={key}
      sort={sort}
      onSort={setSort}
      align={align}
      defaultDesc={key !== 'name'}
      className={cn('px-2', className)}
    />
  );

  function exportCsv() {
    const head = ['project', 'slug', 'status', 'team', 'owner', 'plan', 'db_bytes', 'storage_bytes', 'buckets', 'api_requests', 'egress_bytes', 'tier', 'modeled_cost_usd_projected', 'price_usd_projected', 'created'];
    const lines = rows.map((p) =>
      [p.name, p.slug, p.status, p.team.name, p.owner?.email ?? '', p.plan?.displayName ?? '', p.dbSizeBytes, p.storageBytes, p.bucketCount ?? '', p.apiRequests, p.bandwidthBytes, p.cost?.computeTier ?? '', p.cost?.projectedRawUsd ?? '', p.cost?.projectedPricedUsd ?? '', p.createdAt]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `basefyio-projects-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const searching = query.trim().length > 0;

  return (
    <>
      <PageHeader
        title="Projects"
        description={
          data
            ? `${rows.length} of ${data.projects.length} projects · modeled cost over customer price, projected to month end · buckets measured ${timeAgo(data.storageMeasuredAt)}`
            : 'Every project on the platform'
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              <Download className="mr-2 h-3.5 w-3.5" />
              CSV
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Project, team or owner"
            aria-label="Search projects by name, team or owner"
            className="pl-8"
          />
        </div>
        <FilterChips
          label="Project status"
          options={STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
          value={status}
          onChange={setStatus}
        />
      </div>

      {status === 'DELETED' && (
        <p className="mb-3 text-xs text-muted-foreground">
          Projects in the trash can still be restored. Projects deleted permanently are gone from this list — their
          records stay in the{' '}
          <Link href="/console/manage?tab=deletionReasons" prefetch={false} className="text-primary hover:underline">
            deletion log
          </Link>
          .
        </p>
      )}

      {loading && !data ? (
        <Spinner />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <Panel flush>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  {header('Project', 'name', 'left')}
                  <th className={cn(th, 'px-2')} scope="col">Team · owner</th>
                  <th className={cn(th, 'px-2')} scope="col">Plan</th>
                  {header('Database', 'db')}
                  {header('Files', 'storage')}
                  {header('Total', 'total')}
                  {header('Buckets', 'buckets', 'right', 'hidden 2xl:table-cell')}
                  {header('API req', 'api')}
                  {header('Egress', 'egress')}
                  {header('Cost · price', 'cost')}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className={cn(cell, 'max-w-[220px]')}>
                      <div className="flex min-w-0 items-center gap-2">
                        {/* No prefetch: hundreds of rows each fetched their detail page on scroll. */}
                        <Link
                          href={`/console/projects/${p.id}`}
                          prefetch={false}
                          className="truncate font-medium hover:underline"
                          title={p.name}
                        >
                          {p.name}
                        </Link>
                        {p.status !== 'ACTIVE' && <StatusBadge status={p.status} />}
                      </div>
                      <div className="truncate text-xs text-muted-foreground" title={p.slug}>
                        {p.slug} · {formatDate(p.createdAt)}
                      </div>
                    </td>
                    <td className={cn(cell, 'max-w-[200px]')}>
                      <div className="truncate" title={p.team.name}>{p.team.name}</div>
                      <div className="truncate text-xs text-muted-foreground" title={p.owner?.email ?? ''}>
                        {p.owner?.email ?? '—'}
                      </div>
                    </td>
                    <td className={cn(cell, 'whitespace-nowrap')}>
                      {p.plan ? (
                        <span className={p.plan.priceMonthlyUsd > 0 ? 'font-medium' : 'text-muted-foreground'}>
                          {p.plan.displayName}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={cellRight}>{formatBytes(p.dbSizeBytes)}</td>
                    <td className={cellRight}>{formatBytes(p.storageBytes)}</td>
                    <td className={`${cellRight} font-medium`}>{formatBytes(p.dbSizeBytes + p.storageBytes)}</td>
                    <td className={`${cellRight} hidden 2xl:table-cell`}>{p.bucketCount ?? '—'}</td>
                    <td className={cellRight}>{formatCount(p.apiRequests)}</td>
                    <td className={cellRight}>{formatBytes(p.bandwidthBytes)}</td>
                    <td className={cellRight}>
                      {p.cost ? (
                        <>
                          <div className="font-medium">{formatUsd(p.cost.projectedRawUsd)}</div>
                          <div className="text-xs text-muted-foreground">{formatUsd(p.cost.projectedPricedUsd)}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <EmptyRow colSpan={10}>
                    {searching
                      ? `No projects match "${query.trim()}".`
                      : status === 'DELETED'
                        ? 'The trash is empty.'
                        : 'No projects in this state.'}
                  </EmptyRow>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot className="border-t bg-muted/40 font-medium">
                  <tr>
                    <td className={cell} colSpan={3}>
                      Total · {rows.length} projects
                    </td>
                    <td className={cellRight}>{formatBytes(totals.db)}</td>
                    <td className={cellRight}>{formatBytes(totals.storage)}</td>
                    <td className={cellRight}>{formatBytes(totals.db + totals.storage)}</td>
                    <td className={`${cellRight} hidden 2xl:table-cell`}>{totals.buckets.toLocaleString('en-US')}</td>
                    <td className={cellRight}>{formatCount(totals.api)}</td>
                    <td className={cellRight}>{formatBytes(totals.egress)}</td>
                    <td className={cellRight}>
                      <div>{formatUsd(totals.cost)}</div>
                      <div className="text-xs font-normal text-muted-foreground">{formatUsd(totals.price)}</div>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
