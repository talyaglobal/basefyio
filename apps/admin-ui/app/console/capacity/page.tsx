'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Gauge } from 'lucide-react';
import { api } from '@/lib/api';
import type { CapacityBenchmarkRun, CapacityHistoryPoint, CapacityOverview, SimulationInput } from '@/lib/capacity-types';
import { PageHeader, StatCard, Panel, Spinner, ErrorState, th, td } from '@/components/console/ui';
import { formatCount, formatDate, timeAgo } from '@/components/console/format';
import { cn } from '@/lib/utils';
import { CapacityMeter, Sparkline, fmtUnit, utilizationTone } from '@/components/console/capacity/meters';
import { SimulationPanel } from '@/components/console/capacity/simulation-panel';
import { TrendChart } from '@/components/console/capacity/trend-chart';

function headroomTone(pct: number | null): 'default' | 'good' | 'bad' {
  if (pct === null) return 'default';
  if (pct < 15) return 'bad';
  return 'good';
}

export default function CapacityPage() {
  const [data, setData] = useState<CapacityOverview | null>(null);
  const [history, setHistory] = useState<CapacityHistoryPoint[]>([]);
  const [benchmarks, setBenchmarks] = useState<CapacityBenchmarkRun[]>([]);
  const [scenarios, setScenarios] = useState<Record<string, SimulationInput>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [overview, hist, runs, saved] = await Promise.all([
        api.capacity.overview(),
        api.capacity.history(90).catch(() => []),
        api.capacity.benchmarks().catch(() => []),
        api.capacity.scenarios().catch(() => ({})),
      ]);
      setData(overview);
      setHistory(hist);
      setBenchmarks(runs);
      setScenarios(saved);
    } catch (err: any) {
      setError(err?.message || 'Could not load the capacity data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void api.capacity.overview().then(setData).catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const m = data.model;
  const t = data.metrics?.tenancy;
  const bottleneck = m?.perResource.find((r) => r.key === m.bottleneck);

  return (
    <div>
      <PageHeader
        title="Capacity"
        description="How much the platform carries, how much more fits at today's usage profile, and what a different platform would do."
      />

      {(!data.enabled || data.seedValues || !data.fresh) && (
        <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-600" /> {data.seedValues ? 'Unmeasured: seed values' : 'Measurement is incomplete'}
          </div>
          <ul className="mt-1 list-disc pl-6 text-xs text-muted-foreground">
            {!data.enabled && <li>The sampler is off (CAPACITY_SAMPLER_ENABLED). The numbers below are seeds from the last manual survey, not measurements.</li>}
            {data.enabled && !data.fresh && <li>No sample in the last 3 minutes; the leader may be restarting.</li>}
            {data.seedValues && data.enabled && <li>Fewer than 24 hours of samples: the per-project profile is still the seed; the figures firm up as the day fills.</li>}
            {!data.benchmark.measured && <li>No benchmark yet: the API throughput ceiling is a conservative placeholder ({data.benchmark.rpsPerReplica} req/s per replica).</li>}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Projects served"
          value={m ? formatCount(m.currentProjects) : '—'}
          hint={m ? `${m.awakeProjects} active · ${m.asleepProjects} deactivated${t ? ` · ${t.projects.nosql} document` : ''}` : undefined}
          icon={Gauge}
        />
        <StatCard
          label="Organizations"
          value={t ? formatCount(t.organizations) : '—'}
          hint={t ? `${t.payingOrganizations} on a paid plan` : undefined}
        />
        <StatCard
          label="Max projects at today's profile"
          value={m?.maxProjects !== null && m ? formatCount(m.maxProjects) : '—'}
          hint={m?.maxProjectsAllAwake !== null && m ? `${formatCount(m.maxProjectsAllAwake)} if everyone woke` : undefined}
        />
        <StatCard
          label="Headroom"
          value={m?.headroomProjects !== null && m ? `${formatCount(m.headroomProjects)} projects` : '—'}
          hint={m ? `${m.headroomPct ?? '—'} % · bottleneck: ${bottleneck?.label ?? '—'}` : undefined}
          tone={headroomTone(m?.headroomPct ?? null)}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Data {data.sampledAt ? timeAgo(data.sampledAt) : 'never'}</span>
        <span>Model confidence {m ? Math.round(m.confidence * 100) : 0} % of ceilings measured</span>
        <span>
          Benchmark{' '}
          {data.benchmark.latest ? `${data.benchmark.latest.scenario} ${data.benchmark.latest.finishedAt ? timeAgo(data.benchmark.latest.finishedAt) : ''}` : 'none'}
        </span>
        {data.metrics?.host && <span>Host view: {data.metrics.host.source}</span>}
      </div>

      <Panel className="mt-4" title="Utilization" description="Current against the ceiling; the tick is the target. Each awake project's share is the measured unit cost." flush>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className={th}>Resource</th>
              <th className={th}>Now</th>
              <th className={cn(th, 'w-[40%]')}>Utilization</th>
              <th className={th}>Per awake project</th>
              <th className={th}>24 h</th>
            </tr>
          </thead>
          <tbody>
            {(m?.perResource ?? []).map((r) => {
              const tone = utilizationTone(r.utilization, r.target);
              return (
                <tr key={r.key} className="border-b last:border-0 hover:bg-muted/40">
                  <td className={td}>
                    <div className="font-medium">{r.label}</div>
                    <div className="text-xs text-muted-foreground">
                      ceiling {fmtUnit(r.ceiling, r.unit)}
                      {!r.measured && <span className="ml-1 text-amber-600">(assumed)</span>}
                    </div>
                  </td>
                  <td className={cn(td, 'tabular-nums')}>
                    {fmtUnit(r.current, r.unit)}
                    <div className={cn('text-xs', tone === 'critical' ? 'text-red-600' : tone === 'warning' ? 'text-amber-600' : 'text-muted-foreground')}>
                      {Math.round(r.utilization * 100)} % · target {Math.round(r.target * 100)} %
                    </div>
                  </td>
                  <td className={td}>
                    <CapacityMeter utilization={r.utilization} target={r.target} label={`${r.label} ${Math.round(r.utilization * 100)} %`} />
                  </td>
                  <td className={cn(td, 'tabular-nums text-muted-foreground')}>
                    {r.perProject > 0 ? `≈ ${fmtUnit(r.perProject, r.unit)}` : '—'}
                    {r.maxProjects !== null && <div className="text-xs">full at ~{formatCount(r.maxProjects)}</div>}
                  </td>
                  <td className={td}>
                    <Sparkline points={data.sparklines[r.key] ?? []} max={r.ceiling} label={`${r.label}, last 24 hours`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {data.metrics && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Host"
            value={data.metrics.host?.cpuPct !== null && data.metrics.host ? `${data.metrics.host.cpuPct} % CPU` : '—'}
            hint={data.metrics.host ? `${data.metrics.host.memUsedMb} / ${data.metrics.host.memTotalMb} MB · load ${data.metrics.host.load1}` : 'not read'}
          />
          <StatCard
            label="Postgres"
            value={data.metrics.postgres ? `${data.metrics.postgres.connections} / ${data.metrics.postgres.maxConnections}` : '—'}
            hint={
              data.metrics.postgres
                ? `${data.metrics.postgres.byState.active ?? 0} active · ${data.metrics.postgres.byState.idle ?? 0} idle · cache ${data.metrics.postgres.cacheHitPct ?? '—'} %`
                : 'not read'
            }
          />
          <StatCard
            label="Pooler"
            value={data.metrics.pgbouncer ? `${data.metrics.pgbouncer.pools} pools` : '—'}
            hint={data.metrics.pgbouncer ? `${data.metrics.pgbouncer.clientConns} clients · ${data.metrics.pgbouncer.serverConns} server connections` : 'not read'}
          />
          <StatCard
            label="Redis"
            value={data.metrics.redis ? `${data.metrics.redis.usedMb} MB` : '—'}
            hint={data.metrics.redis ? `${formatCount(data.metrics.redis.keys)} keys · ${data.metrics.redis.evictedKeys} evicted` : 'not read'}
            tone={data.metrics.redis && data.metrics.redis.evictedKeys > 0 ? 'bad' : 'default'}
          />
        </div>
      )}

      <div className="mt-4">
        <SimulationPanel overview={data} scenarios={scenarios} onScenariosChange={() => api.capacity.scenarios().then(setScenarios).catch(() => {})} />
      </div>

      <div className="mt-4">
        <TrendChart history={history} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Recommendations" description="Generated from the model; each one names the resource and the next step.">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {data.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
        </Panel>
        <Panel title="Benchmarks" description="Load-test runs uploaded by the k6 runner; the latest green rest-read run sets the throughput ceiling." flush>
          <table className="w-full whitespace-nowrap text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className={th}>When</th>
                <th className={th}>Scenario</th>
                <th className={th}>Target</th>
                <th className={th}>req/s</th>
                <th className={th}>p95</th>
                <th className={th}>Errors</th>
              </tr>
            </thead>
            <tbody>
              {benchmarks.length === 0 ? (
                <tr>
                  <td className={td} colSpan={6}>
                    <span className="text-muted-foreground">No runs yet. See tools/loadtest in the repository.</span>
                  </td>
                </tr>
              ) : (
                benchmarks.map((b) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className={td}>{formatDate(b.startedAt)}</td>
                    <td className={td}>{b.scenario}</td>
                    <td className={td}>{b.target}</td>
                    <td className={cn(td, 'tabular-nums')}>{b.result?.rps ?? '—'}</td>
                    <td className={cn(td, 'tabular-nums')}>{b.result?.p95 !== undefined ? `${b.result.p95} ms` : '—'}</td>
                    <td className={cn(td, 'tabular-nums')}>{b.result?.errorRate !== undefined ? `${b.result.errorRate} %` : b.status.toLowerCase()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
