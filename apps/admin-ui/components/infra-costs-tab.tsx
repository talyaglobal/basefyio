'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Server } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { InfraCostConfig, PlatformCostReport, PlatformTeamCost, ProjectCostReport } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUsd } from '@/components/project-costs-panel';

const GB = 1024 ** 3;

function fmtBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 2)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return bytes > 0 ? `${Math.round(bytes / 1024)} KB` : '0';
}

function fmtSigned(n: number): string {
  const abs = formatUsd(Math.abs(n));
  return n < 0 ? `-${abs}` : abs;
}

function marginClass(n: number): string {
  return n < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400';
}

function PlanBadge({ plan }: { plan: PlatformTeamCost['plan'] }) {
  if (!plan) return <span className="text-xs text-muted-foreground">no plan</span>;
  const legacy = plan.name === 'legacy';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        legacy
          ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300'
          : plan.priceMonthlyUsd > 0
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
            : 'bg-muted text-muted-foreground'
      }`}
      title={plan.status}
    >
      {plan.displayName}
      {plan.priceMonthlyUsd > 0 ? ` · ${formatUsd(plan.priceMonthlyUsd)}/mo` : ''}
    </span>
  );
}

function ProjectRows({ projects }: { projects: ProjectCostReport[] }) {
  return (
    <>
      {projects.map((p) => (
        <tr key={p.projectId} className="border-b border-dashed text-xs text-muted-foreground">
          <td className="py-1.5 pl-9 pr-3">
            <span className="text-foreground/90">{p.name}</span>
            <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{p.computeTier}</span>
            {p.status !== 'ACTIVE' && <span className="ml-1 text-[10px] uppercase">{p.status}</span>}
          </td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{Math.round(p.activeHours)} h</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{fmtBytes(p.dbSizeBytes)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{fmtBytes(p.storageBytes)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{fmtBytes(p.bandwidthBytes)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{p.apiRequests.toLocaleString('en-US')}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{formatUsd(p.rawUsd)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{formatUsd(p.projectedRawUsd)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums text-foreground/90">{formatUsd(p.projectedPricedUsd)}</td>
          <td />
        </tr>
      ))}
    </>
  );
}

function TeamRow({ team, expanded, onToggle }: { team: PlatformTeamCost; expanded: boolean; onToggle: () => void }) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const sum = (pick: (p: ProjectCostReport) => number) => team.projects.reduce((s, p) => s + pick(p), 0);
  return (
    <>
      <tr className="cursor-pointer border-b hover:bg-muted/40 transition-colors" onClick={onToggle} aria-expanded={expanded}>
        <td className="py-2.5 pr-3">
          <div className="flex items-center gap-2">
            <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="font-medium text-foreground truncate">{team.teamName}</div>
              <div className="text-[11px] text-muted-foreground truncate">
                {team.teamSlug} · {team.projects.length} project{team.projects.length === 1 ? '' : 's'}
              </div>
            </div>
            <PlanBadge plan={team.plan} />
          </div>
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{Math.round(sum((p) => p.activeHours))} h</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{fmtBytes(sum((p) => p.dbSizeBytes))}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{fmtBytes(sum((p) => p.storageBytes))}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{fmtBytes(sum((p) => p.bandwidthBytes))}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{sum((p) => p.apiRequests).toLocaleString('en-US')}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums">{formatUsd(team.totals.rawUsd)}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums font-medium">{formatUsd(team.totals.projectedRawUsd)}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums">{formatUsd(team.totals.projectedPricedUsd)}</td>
        <td className={`py-2.5 text-right tabular-nums font-medium ${marginClass(team.marginUsd)}`}>{fmtSigned(team.marginUsd)}</td>
      </tr>
      {expanded && <ProjectRows projects={team.projects} />}
    </>
  );
}

type Draft = InfraCostConfig;

function NumberField({
  label,
  value,
  onChange,
  step = 'any',
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: string;
  hint?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="number"
        step={step}
        min={0}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className="mt-1 h-8 text-sm"
      />
      {hint && <span className="mt-0.5 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function RatesEditor({
  config,
  onSaved,
  onCancel,
}: {
  config: InfraCostConfig;
  onSaved: (next: InfraCostConfig) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => JSON.parse(JSON.stringify(config)));
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setServer = <K extends keyof Draft['server']>(key: K, value: Draft['server'][K]) =>
    setDraft((d) => ({ ...d, server: { ...d.server, [key]: value } }));

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.billing.updateManagementCostConfig(draft);
      toast.success('Rates saved');
      onSaved(next);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save rates');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border bg-background/50 p-4 space-y-5">
      <div>
        <h3 className="text-sm font-medium">Host</h3>
        <p className="text-xs text-muted-foreground">What the server and its block storage cost us. Every tier price derives from these.</p>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
          <label className="block text-xs col-span-2 md:col-span-1">
            <span className="text-muted-foreground">Label</span>
            <Input value={draft.server.label} onChange={(e) => setServer('label', e.target.value)} className="mt-1 h-8 text-sm" />
          </label>
          <NumberField label="Monthly cost (USD)" value={draft.server.monthlyCostUsd} onChange={(n) => setServer('monthlyCostUsd', n)} />
          <NumberField label="vCPU" value={draft.server.vcpu} onChange={(n) => setServer('vcpu', n)} />
          <NumberField label="Memory (GB)" value={draft.server.memoryGb} onChange={(n) => setServer('memoryGb', n)} />
          <NumberField label="Volume (GB)" value={draft.server.volumeGb} onChange={(n) => setServer('volumeGb', n)} hint="Only used for the actual bill" />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium">Unit rates (our cost)</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <NumberField label="Disk · $/GB-month" value={draft.diskUsdPerGbMonth} onChange={(n) => set('diskUsdPerGbMonth', n)} />
          <NumberField label="Egress · $/GB" value={draft.egressUsdPerGb} onChange={(n) => set('egressUsdPerGb', n)} />
          <NumberField label="API requests · $/million" value={draft.apiRequestsUsdPerMillion} onChange={(n) => set('apiRequestsUsdPerMillion', n)} hint="0 = included in compute" />
          <NumberField label="Markup (×)" value={draft.markup} onChange={(n) => set('markup', n)} step="0.1" hint="Customer price = our cost × markup" />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Compute tiers</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set('computeTiers', [...draft.computeTiers, { name: 'New', vcpu: 1, memoryGb: 2 }])}
          >
            Add tier
          </Button>
        </div>
        <div className="mt-2 space-y-2">
          {draft.computeTiers.map((t, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
              <label className="block text-xs">
                <span className="text-muted-foreground">Name</span>
                <Input
                  value={t.name}
                  onChange={(e) => set('computeTiers', draft.computeTiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  className="mt-1 h-8 text-sm"
                />
              </label>
              <NumberField label="vCPU" value={t.vcpu} onChange={(n) => set('computeTiers', draft.computeTiers.map((x, j) => (j === i ? { ...x, vcpu: n } : x)))} />
              <NumberField label="Memory (GB)" value={t.memoryGb} onChange={(n) => set('computeTiers', draft.computeTiers.map((x, j) => (j === i ? { ...x, memoryGb: n } : x)))} />
              <Button type="button" variant="ghost" size="sm" onClick={() => set('computeTiers', draft.computeTiers.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Shared-infrastructure sizing</h3>
            <p className="text-xs text-muted-foreground">Projects without a dedicated container take the first tier whose database-size ceiling they fit under.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set('sharedTierByDbSize', [...draft.sharedTierByDbSize, { maxDbGb: 100, tier: draft.computeTiers[0]?.name ?? 'Micro' }])}
          >
            Add rule
          </Button>
        </div>
        <div className="mt-2 space-y-2">
          {draft.sharedTierByDbSize.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
              <label className="block text-xs">
                <span className="text-muted-foreground">Database under (GB) — blank = everything else</span>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  value={r.maxDbGb ?? ''}
                  onChange={(e) =>
                    set('sharedTierByDbSize', draft.sharedTierByDbSize.map((x, j) => (j === i ? { ...x, maxDbGb: e.target.value === '' ? null : Number(e.target.value) } : x)))
                  }
                  className="mt-1 h-8 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="text-muted-foreground">Tier</span>
                <select
                  value={r.tier}
                  onChange={(e) => set('sharedTierByDbSize', draft.sharedTierByDbSize.map((x, j) => (j === i ? { ...x, tier: e.target.value } : x)))}
                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                >
                  {draft.computeTiers.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="button" variant="ghost" size="sm" onClick={() => set('sharedTierByDbSize', draft.sharedTierByDbSize.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save rates'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Root/management view: every team's projects with what they cost us, what
 * the customer would see at the markup, and the margin against the plan price.
 */
export function InfraCostsTab() {
  const [report, setReport] = useState<PlatformCostReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [planFilter, setPlanFilter] = useState<string>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.billing.managementProjectCosts());
    } catch (e: any) {
      setError(e?.message || 'Failed to load infrastructure costs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refreshMeasurements = async () => {
    setRefreshing(true);
    try {
      const r = await api.billing.refreshManagementProjectCosts();
      toast.success(`Re-measured ${r.projects} project database${r.projects === 1 ? '' : 's'}`);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const planNames = useMemo(() => {
    const names = new Set<string>();
    report?.teams.forEach((t) => names.add(t.plan?.name ?? 'none'));
    return Array.from(names).sort();
  }, [report]);

  const visibleTeams = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.teams.filter((t) => {
      if (planFilter !== 'all' && (t.plan?.name ?? 'none') !== planFilter) return false;
      if (!q) return true;
      return (
        t.teamName.toLowerCase().includes(q) ||
        t.teamSlug.toLowerCase().includes(q) ||
        t.projects.some((p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
      );
    });
  }, [report, planFilter, query]);

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const summaryCards = report
    ? [
        { label: 'Actual monthly bill', value: formatUsd(report.summary.actualMonthlyBillUsd), color: 'from-slate-500/20 to-slate-600/10 border-slate-500/20', hint: report.config.server.label },
        { label: 'Allocated cost (projected)', value: formatUsd(report.summary.allocatedRawUsd), color: 'from-blue-500/20 to-blue-600/10 border-blue-500/20', hint: `${Math.round(report.summary.recoveryRatio * 100)}% of the bill` },
        { label: `Priced ×${report.config.markup}`, value: formatUsd(report.summary.allocatedPricedUsd), color: 'from-violet-500/20 to-violet-600/10 border-violet-500/20', hint: 'what customers see' },
        { label: 'Plan revenue', value: formatUsd(report.summary.planRevenueUsd), color: 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/20', hint: `${report.summary.teams} teams · ${report.summary.projects} projects` },
        { label: 'Margin vs allocated', value: fmtSigned(report.summary.marginVsAllocatedUsd), color: report.summary.marginVsAllocatedUsd < 0 ? 'from-rose-500/20 to-rose-600/10 border-rose-500/20' : 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/20' },
        { label: 'Margin vs bill', value: fmtSigned(report.summary.marginVsBillUsd), color: report.summary.marginVsBillUsd < 0 ? 'from-rose-500/20 to-rose-600/10 border-rose-500/20' : 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/20' },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-base font-semibold">Infrastructure Costs</h2>
            <p className="text-sm text-muted-foreground">
              What every project costs us this month, the customer price at the markup, and the margin against each plan.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={refreshMeasurements} disabled={refreshing || loading}>
            {refreshing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Re-measure
          </Button>
          <Button type="button" size="sm" variant={editing ? 'secondary' : 'default'} onClick={() => setEditing((v) => !v)} disabled={!report}>
            {editing ? 'Close rates' : 'Edit rates'}
          </Button>
        </div>
      </div>

      {editing && report && (
        <RatesEditor
          config={report.config}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
          }}
        />
      )}

      {loading && !report ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-800/40 bg-red-950/20 p-4 text-sm text-red-200">{error}</div>
      ) : report ? (
        <>
          <div className="flex flex-wrap gap-2">
            {summaryCards.map((c) => (
              <div key={c.label} className={`rounded-xl border bg-gradient-to-br ${c.color} px-3 py-2 backdrop-blur-sm`}>
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{c.label}</div>
                <div className="text-lg font-bold tabular-nums">{c.value}</div>
                {c.hint && <div className="text-[11px] text-muted-foreground">{c.hint}</div>}
              </div>
            ))}
          </div>

          <div className="text-xs text-muted-foreground">
            Period {new Date(report.period.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} –{' '}
            {new Date(report.period.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ·{' '}
            {Math.round(report.period.elapsedFraction * 100)}% elapsed · {report.period.daysLeft} days left.
            {' '}Compute hours count while a project is active; storage is prorated to the time the project existed.
            {report.storagePending ? ' Some projects have no file-storage measurement yet (the storage pass runs every 6 hours).' : ''}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search team or project…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-64 text-sm"
            />
            <select
              value={planFilter}
              onChange={(e) => setPlanFilter(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              <option value="all">All plans</option>
              {planNames.map((n) => (
                <option key={n} value={n}>
                  {n === 'none' ? 'No plan' : n}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {visibleTeams.length} of {report.teams.length} teams
            </span>
            <button
              type="button"
              className="ml-auto text-xs text-primary hover:underline"
              onClick={() => setExpanded(expanded.size ? new Set() : new Set(visibleTeams.map((t) => t.teamId)))}
            >
              {expanded.size ? 'Collapse all' : 'Expand all'}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Team / project</th>
                  <th className="pb-2 pr-3 font-medium text-right">Compute</th>
                  <th className="pb-2 pr-3 font-medium text-right">Database</th>
                  <th className="pb-2 pr-3 font-medium text-right">Files</th>
                  <th className="pb-2 pr-3 font-medium text-right">Egress</th>
                  <th className="pb-2 pr-3 font-medium text-right">API req.</th>
                  <th className="pb-2 pr-3 font-medium text-right">Our cost so far</th>
                  <th className="pb-2 pr-3 font-medium text-right">Our cost / month</th>
                  <th className="pb-2 pr-3 font-medium text-right">Priced / month</th>
                  <th className="pb-2 font-medium text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {visibleTeams.map((t) => (
                  <TeamRow key={t.teamId} team={t} expanded={expanded.has(t.teamId)} onToggle={() => toggle(t.teamId)} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
