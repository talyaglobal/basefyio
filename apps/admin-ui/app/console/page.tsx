'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Box, Database, DollarSign, HardDrive, RefreshCw, Users } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConsoleOverview, ConsolePlanMix, ConsoleTopProject, StorageCategory } from '@/lib/console-types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatBytes, formatCount, formatDate, formatUsd, monthLabel, timeAgo } from '@/components/console/format';
import { ErrorState, PageHeader, Panel, Spinner, StatCard, StatusBadge, td, tdRight, th, thRight } from '@/components/console/ui';
import { DiskPanel } from '@/components/console/disk-panel';

const CATEGORY_LABELS: Record<StorageCategory, string> = {
  project: 'Live projects',
  deleted_project: 'Deleted / deactivated projects',
  platform: 'Platform buckets',
  orphan: 'No owning project',
};

const CATEGORY_COLORS: Record<StorageCategory, string> = {
  project: 'bg-primary',
  deleted_project: 'bg-amber-500',
  platform: 'bg-sky-500',
  orphan: 'bg-red-500',
};

export default function ConsoleOverviewPage() {
  const [data, setData] = useState<ConsoleOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openPlan, setOpenPlan] = useState<ConsolePlanMix | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.console.overview());
    } catch (err: any) {
      setError(err.message || 'Could not load the overview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const { counts, money, footprint } = data;
  const storage = footprint.storage;
  const margin = money.marginVsBillUsd;

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Calendar month ${monthLabel(data.period.start)} · ${data.period.daysLeft} days left · updated ${timeAgo(data.generatedAt)}`}
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Recurring revenue"
          icon={DollarSign}
          value={formatUsd(money.mrrUsd)}
          hint={`${counts.payingTeams} paying of ${counts.teams} teams`}
        />
        <StatCard
          label="Infrastructure bill"
          value={formatUsd(money.actualMonthlyBillUsd)}
          hint={`Projects use ${formatUsd(money.allocatedRawUsd)} of it this month`}
        />
        <StatCard
          label="Margin vs bill"
          value={formatUsd(margin)}
          tone={margin >= 0 ? 'good' : 'bad'}
          hint="Recurring revenue minus the monthly bill"
        />
        <StatCard
          label="Priced usage"
          value={formatUsd(money.allocatedPricedUsd)}
          hint={`What usage is worth at ${money.markup}× markup, projected`}
        />
        <StatCard
          label="Users"
          icon={Users}
          value={formatCount(counts.users)}
          hint={`+${counts.usersLast30d} in 30 days · ${counts.activeUsersLast30d} signed in`}
        />
        <StatCard
          label="Projects"
          icon={Box}
          value={formatCount(counts.projects.active)}
          hint={`${counts.projects.paused} paused · ${counts.projects.deactivated} deactivated · ${counts.projects.deleted} deleted`}
        />
        <StatCard
          label="Databases"
          icon={Database}
          value={formatBytes(footprint.dbBytes)}
          hint={`${formatCount(footprint.apiRequestsMonth)} API requests this month`}
        />
        <StatCard
          label="File storage"
          icon={HardDrive}
          value={formatBytes(storage.totalBytes || footprint.projectStorageBytes)}
          hint={`${formatCount(storage.bucketCount)} buckets · ${formatBytes(footprint.bandwidthMonthBytes)} egress`}
        />
      </div>

      <div className="mt-4">
        <DiskPanel initial={data.disk?.filesystems} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Panel
          className="lg:col-span-3"
          title="Growth"
          description="New users and new projects per month"
        >
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.months.map((m) => ({ ...m, label: monthLabel(m.month) }))} barGap={2}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} width={32} />
                <Tooltip cursor={{ fillOpacity: 0.06 }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="signups" name="New users" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="projects" name="New projects" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel
          className="lg:col-span-2"
          title="Where file storage goes"
          description={storage.measuredAt ? `All buckets, measured ${timeAgo(storage.measuredAt)}` : 'Not measured yet'}
          actions={
            <Link href="/console/storage" className="text-xs font-medium text-primary hover:underline">
              Buckets
            </Link>
          }
        >
          {storage.totalBytes > 0 ? (
            <>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
                {(Object.keys(CATEGORY_LABELS) as StorageCategory[]).map((c) => (
                  <div
                    key={c}
                    className={CATEGORY_COLORS[c]}
                    style={{ width: `${(storage.byCategory[c] / storage.totalBytes) * 100}%` }}
                  />
                ))}
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                {(Object.keys(CATEGORY_LABELS) as StorageCategory[]).map((c) => (
                  <li key={c} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${CATEGORY_COLORS[c]}`} />
                      {CATEGORY_LABELS[c]}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{formatBytes(storage.byCategory[c])}</span>
                  </li>
                ))}
              </ul>
              {storage.byCategory.deleted_project + storage.byCategory.orphan > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {formatBytes(storage.byCategory.deleted_project + storage.byCategory.orphan)} belongs to no live
                  project and can likely be reclaimed.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              The bucket inventory fills in after the next storage pass. Start one from Storage.
            </p>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <TopProjects
          title="Most expensive projects"
          description="Our raw cost, projected to month end"
          rows={data.topByCost}
          metric={(p) => formatUsd(p.projectedRawUsd)}
          secondary={(p) => formatUsd(p.projectedPricedUsd)}
          metricLabel="Our cost"
          secondaryLabel="Priced"
        />
        <TopProjects
          title="Largest projects"
          description="Database plus file storage"
          rows={data.topByFootprint}
          metric={(p) => formatBytes(p.dbSizeBytes + p.storageBytes)}
          secondary={(p) => formatBytes(p.dbSizeBytes)}
          metricLabel="Total"
          secondaryLabel="Database"
        />
      </div>

      <Panel className="mt-4" title="Plan mix" description="Click a plan to see its teams" flush>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className={th}>Plan</th>
              <th className={thRight}>Price</th>
              <th className={thRight}>Teams</th>
              <th className={thRight}>Paying</th>
              <th className={thRight}>Monthly revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.plans.map((p) => (
              <tr
                key={p.name}
                onClick={() => setOpenPlan(p)}
                className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
              >
                <td className={`${td} font-medium text-primary`}>{p.displayName}</td>
                <td className={tdRight}>{formatUsd(p.priceMonthlyUsd)}</td>
                <td className={tdRight}>{p.teams}</td>
                <td className={tdRight}>{p.paying}</td>
                <td className={tdRight}>{formatUsd(p.paying * p.priceMonthlyUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <PlanTeamsDialog plan={openPlan} onClose={() => setOpenPlan(null)} />
    </>
  );
}

function PlanTeamsDialog({ plan, onClose }: { plan: ConsolePlanMix | null; onClose: () => void }) {
  const cost = plan?.teamList.reduce((s, t) => s + t.projectedRawUsd, 0) ?? 0;
  return (
    <Dialog open={!!plan} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-5xl overflow-hidden p-0">
        {plan && (
          <div className="flex max-h-[85vh] flex-col">
            <DialogHeader className="border-b px-6 py-4">
              <DialogTitle>
                {plan.displayName} · {plan.teams} {plan.teams === 1 ? 'team' : 'teams'}
              </DialogTitle>
              <DialogDescription>
                {formatUsd(plan.priceMonthlyUsd)} a month · {plan.paying} paying · their projects cost us{' '}
                {formatUsd(cost)} this month, projected
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-auto">
              <table className="w-full whitespace-nowrap text-sm">
                <thead className="sticky top-0 border-b bg-muted">
                  <tr>
                    <th className={th}>Team</th>
                    <th className={th}>Owner</th>
                    <th className={th}>Status</th>
                    <th className={thRight}>Projects</th>
                    <th className={thRight}>Members</th>
                    <th className={thRight}>Footprint</th>
                    <th className={thRight}>Our cost</th>
                    <th className={thRight}>On plan since</th>
                    <th className={thRight}>Renews</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.teamList.map((t) => (
                    <tr key={t.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className={td}>
                        <Link
                          href={`/console/projects?q=${encodeURIComponent(t.name)}`}
                          className="font-medium hover:underline"
                          title="Show this team's projects"
                        >
                          {t.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">{t.slug}</div>
                      </td>
                      <td className={`${td} text-muted-foreground`}>{t.ownerEmail ?? '—'}</td>
                      <td className={td}>
                        <StatusBadge status={t.status} />
                      </td>
                      <td className={tdRight}>{t.projects}</td>
                      <td className={tdRight}>{t.members}</td>
                      <td className={tdRight}>{t.footprintBytes ? formatBytes(t.footprintBytes) : '—'}</td>
                      <td className={`${tdRight} font-medium`}>{t.projectedRawUsd ? formatUsd(t.projectedRawUsd) : '—'}</td>
                      <td className={`${tdRight} text-muted-foreground`}>{formatDate(t.subscribedAt)}</td>
                      <td className={`${tdRight} text-muted-foreground`}>{formatDate(t.currentPeriodEnd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TopProjects({
  title,
  description,
  rows,
  metric,
  secondary,
  metricLabel,
  secondaryLabel,
}: {
  title: string;
  description: string;
  rows: ConsoleTopProject[];
  metric: (p: ConsoleTopProject) => string;
  secondary: (p: ConsoleTopProject) => string;
  metricLabel: string;
  secondaryLabel: string;
}) {
  return (
    <Panel title={title} description={description} flush>
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No billable projects yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className={th}>Project</th>
              <th className={thRight}>{secondaryLabel}</th>
              <th className={thRight}>{metricLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className={td}>
                  <Link href={`/console/projects/${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">{p.teamName}</div>
                </td>
                <td className={`${tdRight} text-muted-foreground`}>{secondary(p)}</td>
                <td className={`${tdRight} font-medium`}>{metric(p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
