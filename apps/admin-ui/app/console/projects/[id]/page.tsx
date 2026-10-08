'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Globe, Lock, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConsoleProjectDetail } from '@/lib/console-types';
import { Button } from '@/components/ui/button';
import {
  formatBytes,
  formatCount,
  formatDate,
  formatMb,
  formatUsd,
  monthLabel,
  timeAgo,
} from '@/components/console/format';
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

export default function ConsoleProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ConsoleProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.console.project(id));
    } catch (err: any) {
      setError(err.message || 'Could not load the project');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const { project, team, cost, storage, database } = data;
  const footprint = (database.sizeBytes ?? 0) + storage.totalBytes;
  const largestBucket = storage.buckets[0]?.sizeBytes ?? 0;
  const largestTable = database.tables[0]?.totalBytes ?? 0;
  const owner = team.members.find((m) => m.role === 'OWNER');

  return (
    <>
      <Link
        href="/console/projects"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Projects
      </Link>

      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {project.name}
            <StatusBadge status={project.status} />
          </span>
        }
        description={
          <>
            {project.slug} · {team.name}
            {owner ? ` · ${owner.email}` : ''} · created {formatDate(project.createdAt)}
          </>
        }
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} />
            Re-measure
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Footprint"
          value={formatBytes(footprint)}
          hint={`${formatMb(database.sizeBytes)} database · ${formatMb(storage.totalBytes)} files`}
        />
        <StatCard
          label="File storage"
          value={formatBytes(storage.totalBytes)}
          hint={`${storage.buckets.length} buckets · ${formatCount(storage.objectCount)} objects`}
        />
        <StatCard
          label="Our cost, month"
          value={cost ? formatUsd(cost.projectedRawUsd) : '—'}
          hint={cost ? `${formatUsd(cost.rawUsd)} so far · ${cost.computeTier}` : 'Not billable in this state'}
        />
        <StatCard
          label="Priced, month"
          value={cost ? formatUsd(cost.projectedPricedUsd) : '—'}
          hint={
            team.plan
              ? `Team pays ${formatUsd(team.plan.priceMonthlyUsd)} on ${team.plan.displayName}`
              : 'No subscription'
          }
        />
      </div>

      {cost && (
        <Panel className="mt-4" title="Cost breakdown" description="Calendar month, projected linearly to month end" flush>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className={th}>Line</th>
                <th className={th}>Usage</th>
                <th className={thRight}>Our cost so far</th>
                <th className={thRight}>Our cost, projected</th>
                <th className={thRight}>Priced, projected</th>
              </tr>
            </thead>
            <tbody>
              {cost.lines.map((l) => (
                <tr key={l.key} className="border-b last:border-0">
                  <td className={`${td} font-medium`}>{l.label}</td>
                  <td className={`${td} text-muted-foreground`}>{l.detail}</td>
                  <td className={tdRight}>{formatUsd(l.rawUsd)}</td>
                  <td className={tdRight}>{formatUsd(l.projectedRawUsd)}</td>
                  <td className={`${tdRight} text-muted-foreground`}>{formatUsd(l.projectedPricedUsd)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t bg-muted/40 font-medium">
              <tr>
                <td className={td} colSpan={2}>
                  Total
                </td>
                <td className={tdRight}>{formatUsd(cost.rawUsd)}</td>
                <td className={tdRight}>{formatUsd(cost.projectedRawUsd)}</td>
                <td className={tdRight}>{formatUsd(cost.projectedPricedUsd)}</td>
              </tr>
            </tfoot>
          </table>
        </Panel>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel
          title="Buckets"
          description={
            storage.live
              ? 'Measured live just now'
              : storage.measuredAt
                ? `From the storage pass ${timeAgo(storage.measuredAt)}`
                : 'Not measured yet'
          }
          flush
        >
          {storage.buckets.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">This project has no buckets.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className={th}>Bucket</th>
                  <th className={thRight}>Objects</th>
                  <th className={thRight}>Size</th>
                  <th className={`${th} w-28`} />
                </tr>
              </thead>
              <tbody>
                {storage.buckets.map((b) => (
                  <tr key={b.bucket} className="border-b last:border-0">
                    <td className={td}>
                      <div className="flex items-center gap-1.5 font-medium">
                        {b.public === true ? (
                          <Globe className="h-3.5 w-3.5 text-amber-500" aria-label="Public" />
                        ) : b.public === false ? (
                          <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Private" />
                        ) : null}
                        {b.name}
                      </div>
                      <div className="text-xs text-muted-foreground">{b.bucket}</div>
                    </td>
                    <td className={tdRight}>{formatCount(b.objectCount)}</td>
                    <td className={`${tdRight} font-medium`}>{formatMb(b.sizeBytes)}</td>
                    <td className={td}>
                      <Meter value={largestBucket ? b.sizeBytes / largestBucket : 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Largest tables"
          description={`Database ${project.dbName} · ${formatMb(database.sizeBytes)} · measured ${timeAgo(database.measuredAt)}`}
          flush
        >
          {database.tablesError ? (
            <p className="p-4 text-sm text-muted-foreground">Could not read table sizes: {database.tablesError}</p>
          ) : database.tables.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No tables yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className={th}>Table</th>
                  <th className={thRight}>Rows (est.)</th>
                  <th className={thRight}>Indexes</th>
                  <th className={thRight}>Total</th>
                  <th className={`${th} w-24`} />
                </tr>
              </thead>
              <tbody>
                {database.tables.map((t) => (
                  <tr key={`${t.schema}.${t.name}`} className="border-b last:border-0">
                    <td className={td}>
                      <span className="text-muted-foreground">{t.schema}.</span>
                      <span className="font-medium">{t.name}</span>
                    </td>
                    <td className={tdRight}>{formatCount(t.estimatedRows)}</td>
                    <td className={`${tdRight} text-muted-foreground`}>{formatBytes(t.indexBytes)}</td>
                    <td className={`${tdRight} font-medium`}>{formatBytes(t.totalBytes)}</td>
                    <td className={td}>
                      <Meter value={largestTable ? t.totalBytes / largestTable : 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="Team" description={`${team.name} · ${team.projectCount} projects`} flush>
          <table className="w-full text-sm">
            <tbody>
              {team.members.map((m) => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className={td}>
                    <div className="font-medium">{m.name ?? m.email}</div>
                    {m.name && <div className="text-xs text-muted-foreground">{m.email}</div>}
                  </td>
                  <td className={`${tdRight} text-xs text-muted-foreground`}>{m.role.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            Plan: {team.plan ? `${team.plan.displayName} · ${team.plan.status.toLowerCase()}` : 'none'}
            {team.plan?.currentPeriodEnd ? ` · renews ${formatDate(team.plan.currentPeriodEnd)}` : ''}
          </div>
        </Panel>

        <Panel title="Setup">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Data model</dt>
            <dd>{project.databaseType.toLowerCase()}</dd>
            <dt className="text-muted-foreground">Origin</dt>
            <dd>{project.importSource.toLowerCase()}</dd>
            <dt className="text-muted-foreground">Compute</dt>
            <dd>
              {data.infrastructure
                ? `${data.infrastructure.pgMemoryMb} MB · ${data.infrastructure.pgCpuMillis / 1000} vCPU · ${data.infrastructure.status.toLowerCase()}`
                : `Shared${cost ? ` · ${cost.computeTier}` : ''}`}
            </dd>
            <dt className="text-muted-foreground">API requests</dt>
            <dd>{cost ? `${formatCount(cost.apiRequests)} this month` : '—'}</dd>
            <dt className="text-muted-foreground">Egress</dt>
            <dd>{cost ? `${formatBytes(cost.bandwidthBytes)} this month` : '—'}</dd>
            {project.deactivatedAt && (
              <>
                <dt className="text-muted-foreground">Deactivated</dt>
                <dd>{formatDate(project.deactivatedAt)}</dd>
              </>
            )}
            {project.deletedAt && (
              <>
                <dt className="text-muted-foreground">Deleted</dt>
                <dd>{formatDate(project.deletedAt)}</dd>
              </>
            )}
          </dl>
        </Panel>

        <Panel title="Monthly history" description="Closed months from the usage ledger" flush>
          {data.history.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No closed months yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className={th}>Month</th>
                  <th className={thRight}>DB</th>
                  <th className={thRight}>Files</th>
                  <th className={thRight}>API</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.periodStart} className="border-b last:border-0">
                    <td className={td}>{monthLabel(h.periodStart)}</td>
                    <td className={tdRight}>{formatMb(h.dbSizeBytes)}</td>
                    <td className={tdRight}>{formatMb(h.storageBytes)}</td>
                    <td className={tdRight}>{formatCount(h.apiRequests)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
