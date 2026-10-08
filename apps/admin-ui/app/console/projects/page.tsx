'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Download, RefreshCw, Search } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConsoleProjectList, ConsoleProjectRow } from '@/lib/console-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCount, formatDate, formatMb, formatUsd, timeAgo } from '@/components/console/format';
import { ErrorState, PageHeader, Panel, Spinner, StatusBadge, td, tdRight, th, thRight } from '@/components/console/ui';
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

export default function ConsoleProjectsPage() {
  const [data, setData] = useState<ConsoleProjectList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('ALL');
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

  function header(label: string, key: SortKey, right = true) {
    const active = sort.key === key;
    const Arrow = sort.desc ? ArrowDown : ArrowUp;
    return (
      <th className={right ? thRight : th}>
        <button
          onClick={() => setSort({ key, desc: active ? !sort.desc : key !== 'name' })}
          className={cn('inline-flex items-center gap-1 uppercase hover:text-foreground', active && 'text-foreground')}
        >
          {label}
          {active && <Arrow className="h-3 w-3" />}
        </button>
      </th>
    );
  }

  function exportCsv() {
    const head = ['project', 'slug', 'status', 'team', 'owner', 'plan', 'db_bytes', 'storage_bytes', 'buckets', 'api_requests', 'egress_bytes', 'tier', 'our_cost_usd_projected', 'price_usd_projected', 'created'];
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

  return (
    <>
      <PageHeader
        title="Projects"
        description={
          data
            ? `${rows.length} of ${data.projects.length} projects · our cost over customer price, projected to month end · buckets measured ${timeAgo(data.storageMeasuredAt)}`
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
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Project, team or owner"
            className="pl-8"
          />
        </div>
        <div className="flex rounded-md border bg-card p-0.5">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium',
                status === s ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <Spinner />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <Panel flush>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  {header('Project', 'name', false)}
                  <th className={th}>Team · owner</th>
                  <th className={th}>Plan</th>
                  {header('Database', 'db')}
                  {header('Files', 'storage')}
                  {header('Total', 'total')}
                  {header('Buckets', 'buckets')}
                  {header('API req', 'api')}
                  {header('Egress', 'egress')}
                  {header('Cost · price', 'cost')}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <Link href={`/console/projects/${p.id}`} className="font-medium hover:underline">
                          {p.name}
                        </Link>
                        {p.status !== 'ACTIVE' && <StatusBadge status={p.status} />}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {p.slug} · {formatDate(p.createdAt)}
                      </div>
                    </td>
                    <td className={td}>
                      <div>{p.team.name}</div>
                      <div className="text-xs text-muted-foreground">{p.owner?.email ?? '—'}</div>
                    </td>
                    <td className={td}>
                      {p.plan ? (
                        <span className={p.plan.priceMonthlyUsd > 0 ? 'font-medium' : 'text-muted-foreground'}>
                          {p.plan.displayName}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={tdRight}>{formatMb(p.dbSizeBytes)}</td>
                    <td className={tdRight}>{formatMb(p.storageBytes)}</td>
                    <td className={`${tdRight} font-medium`}>{formatMb(p.dbSizeBytes + p.storageBytes)}</td>
                    <td className={tdRight}>{p.bucketCount ?? '—'}</td>
                    <td className={tdRight}>{formatCount(p.apiRequests)}</td>
                    <td className={tdRight}>{formatMb(p.bandwidthBytes)}</td>
                    <td className={tdRight}>
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
                  <tr>
                    <td colSpan={10} className="px-3 py-10 text-center text-sm text-muted-foreground">
                      No projects match.
                    </td>
                  </tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot className="border-t bg-muted/40 font-medium">
                  <tr>
                    <td className={td} colSpan={3}>
                      Total · {rows.length} projects
                    </td>
                    <td className={tdRight}>{formatMb(totals.db)}</td>
                    <td className={tdRight}>{formatMb(totals.storage)}</td>
                    <td className={tdRight}>{formatMb(totals.db + totals.storage)}</td>
                    <td className={tdRight}>{totals.buckets}</td>
                    <td className={tdRight}>{formatCount(totals.api)}</td>
                    <td className={tdRight}>{formatMb(totals.egress)}</td>
                    <td className={tdRight}>
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
