'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Activity, AlertTriangle, Plus, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import type { ComponentState, ConsoleStatus, IncidentStatus, IncidentView, ProbeName } from '@/lib/platform-status-types';
import { PageHeader, StatCard, Panel, Spinner, ErrorState, th, td } from '@/components/console/ui';
import { formatDate, timeAgo } from '@/components/console/format';
import { Button } from '@/components/ui/button';
import { confirmDialog, promptDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

const STATE_TONE: Record<ComponentState, string> = {
  operational: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-red-500',
  unknown: 'bg-muted-foreground/40',
};

const NEXT_STATUS: Record<IncidentStatus, IncidentStatus | null> = {
  INVESTIGATING: 'IDENTIFIED',
  IDENTIFIED: 'MONITORING',
  MONITORING: 'RESOLVED',
  RESOLVED: null,
};

function pct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(v >= 99.99 ? 3 : 2)} %`;
}

function dayColour(availabilityPct: number | null): string {
  if (availabilityPct === null) return 'bg-muted-foreground/20';
  if (availabilityPct >= 99.97) return 'bg-emerald-500';
  if (availabilityPct >= 99) return 'bg-amber-500';
  return 'bg-red-500';
}

function burnTone(rate: number): string {
  if (rate >= 14.4) return 'text-red-600';
  if (rate >= 6) return 'text-amber-600';
  return 'text-muted-foreground';
}

export default function ReliabilityPage() {
  const [data, setData] = useState<ConsoleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.platformStatus.console());
    } catch (err: any) {
      setError(err?.message || 'Could not load the reliability data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function newIncident(maintenance: boolean) {
    const title = await promptDialog({
      title: maintenance ? 'Announce maintenance' : 'Open an incident',
      description: maintenance
        ? 'Its minutes will not count against the SLO. Announce it at least 48 hours ahead.'
        : 'What is happening, in one line. You can add updates as you learn more.',
      confirmText: maintenance ? 'Announce' : 'Open',
    } as any);
    if (!title) return;
    setBusy('new');
    try {
      await api.platformStatus.createIncident({
        title,
        impact: maintenance ? 'NONE' : 'MINOR',
        excludedFromSlo: maintenance,
        status: maintenance ? 'MONITORING' : 'INVESTIGATING',
      });
      toast.success(maintenance ? 'Maintenance announced' : 'Incident opened');
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  async function advance(i: IncidentView) {
    const next = NEXT_STATUS[i.status];
    if (!next) return;
    const text = await promptDialog({
      title: next === 'RESOLVED' ? 'Resolve the incident' : `Mark as ${next.toLowerCase()}`,
      description: 'A note for the status page (optional).',
      confirmText: next === 'RESOLVED' ? 'Resolve' : 'Update',
    } as any);
    if (text === null) return;
    setBusy(i.id);
    try {
      await api.platformStatus.updateIncident(i.id, { status: next, text: text || undefined });
      toast.success(next === 'RESOLVED' ? 'Incident resolved' : 'Incident updated');
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not update');
    } finally {
      setBusy(null);
    }
  }

  async function toggleMaintenance(i: IncidentView) {
    const ok = await confirmDialog({
      title: i.excludedFromSlo ? 'Count this against the SLO?' : 'Mark as maintenance?',
      description: i.excludedFromSlo
        ? 'Its minutes will count as downtime again.'
        : 'Its minutes will be excluded from the availability figures. Only for maintenance announced ahead.',
      confirmText: i.excludedFromSlo ? 'Count it' : 'Mark as maintenance',
    });
    if (!ok) return;
    setBusy(i.id);
    try {
      await api.platformStatus.updateIncident(i.id, { excludedFromSlo: !i.excludedFromSlo });
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not update');
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const apiComponent = data.components.find((c) => c.probe === 'api');
  const worst = data.components.reduce(
    (acc, c) => Math.min(acc, c.month.availabilityPct ?? 100),
    100,
  );
  const openIncidents = data.incidents.open.filter((i) => !i.excludedFromSlo);

  return (
    <div>
      <PageHeader
        title="Reliability"
        description="Availability as the probes see it, the error budget per indicator and the incident timeline the status page publishes."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => newIncident(true)} disabled={busy === 'new'}>
              <Wrench className="mr-1.5 h-3.5 w-3.5" /> Announce maintenance
            </Button>
            <Button size="sm" onClick={() => newIncident(false)} disabled={busy === 'new'}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Open incident
            </Button>
          </div>
        }
      />

      {(!data.enabled || !data.tokenConfigured || !data.canary.configured) && (
        <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-600" /> Measurement is not complete
          </div>
          <ul className="mt-1 list-disc pl-6 text-xs text-muted-foreground">
            {!data.enabled && <li>The internal prober is off (PLATFORM_STATUS_ENABLED). Nothing is being measured from inside.</li>}
            {!data.tokenConfigured && <li>No external monitor token (PLATFORM_STATUS_PROBE_TOKEN): only internal samples can arrive, which cannot see a dead host.</li>}
            {!data.canary.configured && (
              <li>
                No canary project yet: the keyed REST, database, storage and realtime probes are skipped.{' '}
                <button
                  type="button"
                  className="underline underline-offset-2 disabled:opacity-50"
                  disabled={busy === 'canary'}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: 'Create the canary project?',
                      description:
                        'A real project named slo-canary in your personal organization (it uses one project slot) with one table and one public object. The probes target it from the next tick on.',
                      confirmText: 'Create canary',
                    });
                    if (!ok) return;
                    setBusy('canary');
                    try {
                      await api.platformStatus.createCanary();
                      toast.success('Canary project created');
                      await load();
                    } catch (err: any) {
                      toast.error(err?.message || 'Could not create the canary');
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === 'canary' ? 'Creating…' : 'Create it now'}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Overall"
          value={data.live ? data.overall : 'stale'}
          hint={data.live ? `updated ${timeAgo(data.generatedAt)}` : 'no probe in the last 5 minutes'}
          icon={Activity}
          tone={data.overall === 'operational' ? 'good' : data.overall === 'down' ? 'bad' : 'default'}
        />
        <StatCard
          label="Worst indicator this month"
          value={pct(worst === 100 ? (apiComponent?.month.availabilityPct ?? null) : worst)}
          hint="lowest availability across the six"
          tone={worst < 99.9 ? 'bad' : 'default'}
        />
        <StatCard
          label="API p95 latency"
          value={data.apiLatencyP95Ms === null ? '—' : `${data.apiLatencyP95Ms} ms`}
          hint="target under 300 ms (today)"
          tone={data.apiLatencyP95Ms !== null && data.apiLatencyP95Ms > 300 ? 'bad' : 'default'}
        />
        <StatCard
          label="Error rate"
          value={data.errorRatePct === null ? '—' : `${data.errorRatePct} %`}
          hint="5xx share, last 5 minutes, target under 0.1 %"
          tone={data.errorRatePct !== null && data.errorRatePct > 0.1 ? 'bad' : 'default'}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Status page subscribers: <strong className="text-foreground">{data.subscribers?.confirmed ?? 0}</strong> confirmed
        {data.subscribers?.pending ? <> · {data.subscribers.pending} awaiting confirmation</> : null}. Every incident you open,
        update or resolve here is mailed to them.
      </p>

      <Panel className="mt-4" title="Indicators" description="Calendar month against the target; budget in minutes; burn rate 1 = spending the month's budget evenly." flush>
        <table className="w-full whitespace-nowrap text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className={th}>Indicator</th>
              <th className={th}>Now</th>
              <th className={th}>Month</th>
              <th className={th}>Budget left</th>
              <th className={th}>Burn 1h / 6h / 24h</th>
              <th className={th}>90 days</th>
              <th className={th}>Last 90 days</th>
            </tr>
          </thead>
          <tbody>
            {data.components.map((c) => {
              const b = data.burn[c.probe as ProbeName];
              return (
                <tr key={c.probe} className="border-b last:border-0 hover:bg-muted/40">
                  <td className={td}>
                    <div className="font-medium">{c.label}</div>
                    <div className="text-xs text-muted-foreground">target {c.targetPct} %</div>
                  </td>
                  <td className={td}>
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn('h-2 w-2 rounded-full', STATE_TONE[c.state])} />
                      {c.state}
                      {c.latencyMs !== null && <span className="text-xs text-muted-foreground">{c.latencyMs} ms</span>}
                    </span>
                  </td>
                  <td className={cn(td, c.month.availabilityPct !== null && c.month.availabilityPct < c.targetPct && 'text-red-600 font-medium')}>
                    {pct(c.month.availabilityPct)}
                    <div className="text-xs text-muted-foreground">{c.month.downMinutes} min down / {c.month.observedMinutes} observed</div>
                  </td>
                  <td className={cn(td, c.month.remainingMinutes <= 0 && 'text-red-600 font-medium')}>
                    {c.month.remainingMinutes.toFixed(1)} / {c.month.budgetMinutes.toFixed(1)} min
                  </td>
                  <td className={td}>
                    {b ? (
                      <span>
                        <span className={burnTone(b.h1)}>{b.h1}</span> / <span className={burnTone(b.h6)}>{b.h6}</span> /{' '}
                        <span className={burnTone(b.h24)}>{b.h24}</span>
                      </span>
                    ) : '—'}
                  </td>
                  <td className={td}>
                    <div className="flex h-4 w-44 gap-[1px]">
                      {c.days.map((d) => (
                        <span key={d.day} className={cn('flex-1 rounded-[1px]', dayColour(d.availabilityPct))} title={`${d.day}: ${d.availabilityPct ?? 'no data'}`} />
                      ))}
                    </div>
                  </td>
                  <td className={td}>{pct(c.last90d.availabilityPct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Incidents" description={`${openIncidents.length} open · ${data.maintenance.length} maintenance announced`}>
          {data.incidents.open.length === 0 && data.maintenance.length === 0 && data.incidents.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing open and nothing in the last 30 days.</p>
          ) : (
            <ul className="space-y-3">
              {[...data.incidents.open, ...data.maintenance, ...data.incidents.recent].map((i) => (
                <li key={i.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">
                        {i.title}
                        {i.auto && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">auto</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {i.excludedFromSlo ? 'maintenance' : `${i.status.toLowerCase()} · ${i.impact.toLowerCase()}`} · {formatDate(i.startedAt)}
                        {i.resolvedAt && <> → {formatDate(i.resolvedAt)}</>}
                        {i.components.length > 0 && <> · {i.components.join(', ')}</>}
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      {NEXT_STATUS[i.status] && (
                        <Button size="sm" variant="outline" disabled={busy === i.id} onClick={() => advance(i)}>
                          {NEXT_STATUS[i.status] === 'RESOLVED' ? 'Resolve' : `→ ${NEXT_STATUS[i.status]!.toLowerCase()}`}
                        </Button>
                      )}
                      {i.status !== 'RESOLVED' && (
                        <Button size="sm" variant="ghost" disabled={busy === i.id} onClick={() => toggleMaintenance(i)} title="Toggle maintenance (excluded from the SLO)">
                          <Wrench className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {i.updates.length > 0 && (
                    <ol className="mt-2 space-y-1 border-l pl-3 text-xs">
                      {i.updates.slice().reverse().slice(0, 4).map((u) => (
                        <li key={u.ts}>
                          <span className="text-muted-foreground">{formatDate(u.ts)} · {u.status.toLowerCase()}</span> {u.text}
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Timeline" description="Deploys and the host's own events, so a blip has its explanation next to it.">
          {data.deploys.length === 0 && data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deploy markers or events yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {[
                ...data.deploys.map((d) => ({ key: `d-${d.id}`, at: d.startedAt, text: `Deploy ${d.imageTag}${d.note ? ` — ${d.note}` : ''}`, tone: 'text-muted-foreground' })),
                ...data.events.map((e) => ({ key: `e-${e.id}`, at: e.occurredAt, text: `${e.source}: ${e.title}`, tone: e.severity === 'critical' ? 'text-red-600' : 'text-amber-600' })),
              ]
                .sort((a, b) => (a.at < b.at ? 1 : -1))
                .slice(0, 40)
                .map((row) => (
                  <li key={row.key} className="flex gap-3">
                    <span className="w-36 shrink-0 text-xs text-muted-foreground">{formatDate(row.at)}</span>
                    <span className={row.tone}>{row.text}</span>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel className="mt-4" title="Probe detail" description={`Latest samples per indicator and vantage point (${data.vantages.join(', ') || 'none yet'}).`} flush>
        <table className="w-full whitespace-nowrap text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className={th}>When</th>
              <th className={th}>Indicator</th>
              <th className={th}>Vantage</th>
              <th className={th}>Result</th>
              <th className={th}>Latency</th>
              <th className={th}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.probes.length === 0 ? (
              <tr>
                <td className={td} colSpan={6}>
                  <span className="text-muted-foreground">No samples yet.</span>
                </td>
              </tr>
            ) : (
              data.probes.map((p) => (
                <tr key={`${p.probe}-${p.vantage}-${p.ts}`} className="border-b last:border-0 hover:bg-muted/40">
                  <td className={td}>{formatDate(p.ts)}</td>
                  <td className={td}>{p.probe}</td>
                  <td className={td}>{p.vantage}</td>
                  <td className={cn(td, p.ok ? 'text-emerald-600' : 'text-red-600')}>{p.ok ? 'ok' : `fail${p.statusCode ? ` ${p.statusCode}` : ''}`}</td>
                  <td className={td}>{p.latencyMs === null ? '—' : `${p.latencyMs} ms`}</td>
                  <td className={cn(td, 'max-w-[320px] truncate text-muted-foreground')} title={p.detail ?? ''}>{p.detail ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
