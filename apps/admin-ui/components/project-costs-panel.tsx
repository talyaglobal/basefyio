'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import type { CustomerProjectCost, TeamCostReport } from '@/lib/types';

/** Dollars with two decimals; tiny non-zero amounts read "< $0.01" instead of "$0.00". */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.005) return '< $0.01';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function formatRate(n: number, unit: string): string {
  if (n === 0) return 'Included';
  const digits = n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
  return `$${n.toFixed(digits)}${unit}`;
}

function formatPeriodDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function StatusPill({ status }: { status: string }) {
  if (status === 'ACTIVE') return null;
  return (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
      {status === 'PAUSED' ? 'Paused' : status.toLowerCase()}
    </span>
  );
}

function ProjectRow({
  project,
  expanded,
  onToggle,
}: {
  project: CustomerProjectCost;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <tr
        className="cursor-pointer border-b hover:bg-muted/40 transition-colors"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <td className="py-2.5 pr-3">
          <div className="flex items-center gap-2">
            <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Link
              href={`/dashboard/projects/${project.projectId}`}
              className="font-medium text-foreground hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {project.name}
            </Link>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {project.computeTier} compute
            </span>
            <StatusPill status={project.status} />
          </div>
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-foreground">{formatUsd(project.amountUsd)}</td>
        <td className="py-2.5 text-right tabular-nums text-muted-foreground">{formatUsd(project.projectedUsd)}</td>
      </tr>
      {expanded &&
        project.lines.map((line) => (
          <tr key={line.key} className="border-b border-dashed last:border-solid text-muted-foreground">
            <td className="py-1.5 pl-9 pr-3">
              <span className="text-foreground/80">{line.label}</span>
              <span className="ml-2 text-xs">{line.detail}</span>
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{formatUsd(line.amountUsd)}</td>
            <td className="py-1.5 text-right tabular-nums">{formatUsd(line.projectedUsd)}</td>
          </tr>
        ))}
    </>
  );
}

/**
 * Per-project cost breakdown for the current billing period, shown under
 * Billing. Figures are at standard usage rates; the plan is still billed at
 * its flat price, so this is where the usage behind that price goes.
 */
export function ProjectCostsPanel({ report }: { report: TeamCostReport | null }) {
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [showRates, setShowRates] = useState(false);

  // Expand everything for small teams; big teams start collapsed so the table stays scannable.
  const effectiveExpanded = useMemo(() => {
    if (expanded) return expanded;
    if (!report) return new Set<string>();
    return new Set(report.projects.length <= 5 ? report.projects.map((p) => p.projectId) : []);
  }, [expanded, report]);

  const toggle = (id: string) => {
    const next = new Set(effectiveExpanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  if (!report) return null;

  const { period, projects, totals, rates } = report;
  const progress = Math.round(period.elapsedFraction * 100);

  return (
    <div className="rounded-xl border bg-card p-6">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        {/* Period + explanation */}
        <div className="lg:col-span-1 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Project costs</h2>
            <p className="text-sm text-muted-foreground mt-1">
              What each project&apos;s compute, storage and traffic add up to this billing period.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">
                {formatPeriodDay(period.start)} – {formatPeriodDay(period.end)}
              </span>
              <span className="text-muted-foreground">
                {period.daysLeft} {period.daysLeft === 1 ? 'day' : 'days'} left
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Figures are priced at standard usage rates and keep updating until the period ends on{' '}
            {formatPeriodDay(period.end)}.{' '}
            {report.plan ? (
              <>
                Your <span className="text-foreground">{report.plan.displayName}</span> plan is billed at its
                flat monthly price; this breakdown shows how the usage behind it is distributed across your projects.
              </>
            ) : null}
          </p>

          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              File storage is measured every 6 hours; new projects can take up to 6 hours to appear.
              {report.storagePending ? ' Some projects have not had their file storage measured yet.' : ''}
            </span>
          </p>

          <button
            type="button"
            className="text-sm text-primary hover:underline"
            onClick={() => setShowRates((v) => !v)}
          >
            {showRates ? 'Hide usage rates' : 'Show usage rates'}
          </button>

          {showRates && (
            <div className="rounded-lg border bg-background/50 p-3 text-xs space-y-3">
              <div>
                <div className="font-medium text-foreground mb-1.5">Compute</div>
                <table className="w-full">
                  <tbody>
                    {rates.computeTiers.map((t) => (
                      <tr key={t.name} className="text-muted-foreground">
                        <td className="py-0.5 pr-2 text-foreground/80">{t.name}</td>
                        <td className="py-0.5 pr-2">
                          {t.vcpu} vCPU · {t.memoryGb} GB
                        </td>
                        <td className="py-0.5 text-right tabular-nums">{formatRate(t.hourlyUsd, '/h')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-muted-foreground">
                  Projects on shared infrastructure are sized by their database footprint.
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-y-1 text-muted-foreground">
                <dt className="text-foreground/80">Database &amp; file storage</dt>
                <dd className="text-right tabular-nums">{formatRate(rates.diskUsdPerGbMonth, '/GB-month')}</dd>
                <dt className="text-foreground/80">Egress</dt>
                <dd className="text-right tabular-nums">{formatRate(rates.egressUsdPerGb, '/GB')}</dd>
                <dt className="text-foreground/80">API requests</dt>
                <dd className="text-right tabular-nums">{formatRate(rates.apiRequestsUsdPerMillion, '/M')}</dd>
              </dl>
            </div>
          )}
        </div>

        {/* Breakdown */}
        <div className="lg:col-span-2">
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active projects in this billing period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b">
                    <th className="pb-2 pr-3 font-medium">Project</th>
                    <th className="pb-2 pr-3 font-medium text-right">So far</th>
                    <th className="pb-2 font-medium text-right">Projected</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <ProjectRow
                      key={p.projectId}
                      project={p}
                      expanded={effectiveExpanded.has(p.projectId)}
                      onToggle={() => toggle(p.projectId)}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-b">
                    <td className="py-3 pr-3 font-semibold text-foreground">Current costs</td>
                    <td className="py-3 pr-3 text-right font-semibold tabular-nums text-foreground">
                      {formatUsd(totals.amountUsd)}
                    </td>
                    <td />
                  </tr>
                  <tr>
                    <td className="py-3 pr-3 font-semibold text-foreground">Projected costs</td>
                    <td />
                    <td className="py-3 text-right font-semibold tabular-nums text-foreground">
                      {formatUsd(totals.projectedUsd)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
