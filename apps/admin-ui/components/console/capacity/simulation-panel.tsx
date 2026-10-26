'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { CapacityOverview, SimulationInput, SimulationResult } from '@/lib/capacity-types';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/console/ui';
import { promptDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { CapacityMeter, fmtUnit, utilizationTone } from './meters';

const PRESET_LABELS: Record<string, string> = {
  today: 'Today',
  everyone_awake: 'Everyone awake',
  customers_100: '100 customers',
  customers_500: '500 customers',
  customers_1000: '1 000 customers',
  customers_5000: '5 000 customers',
};

interface Field {
  key: keyof SimulationInput;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}

const FIELDS: Field[] = [
  { key: 'projects', label: 'Projects', min: 1, max: 20000, step: 1 },
  { key: 'awakeShare', label: 'Awake share', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)} %` },
  { key: 'rpsPerProject', label: 'Requests / s per awake project', min: 0, max: 50, step: 0.01 },
  { key: 'dbConnectionsPerProject', label: 'DB connections per awake project', min: 0, max: 50, step: 0.1 },
  { key: 'dbGbPerProject', label: 'Database GB per project', min: 0, max: 100, step: 0.05 },
  { key: 'storageGbPerProject', label: 'Storage GB per project', min: 0, max: 500, step: 0.1 },
  { key: 'sseClientsPerProject', label: 'Realtime clients per awake project', min: 0, max: 100, step: 0.1 },
  { key: 'apiReplicas', label: 'API replicas', min: 1, max: 16, step: 1 },
];

export function SimulationPanel({ overview, scenarios, onScenariosChange }: { overview: CapacityOverview; scenarios: Record<string, SimulationInput>; onScenariosChange: () => void }) {
  const [input, setInput] = useState<SimulationInput>(overview.presets.today);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [pending, setPending] = useState(false);
  const [pgCeiling, setPgCeiling] = useState<number | ''>('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const payload = useMemo<SimulationInput>(
    () => ({ ...input, ceilings: pgCeiling !== '' && pgCeiling > 0 ? { pg_connections: Number(pgCeiling) } : undefined }),
    [input, pgCeiling],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    setPending(true);
    timer.current = setTimeout(async () => {
      try {
        setResult(await api.capacity.simulate(payload));
      } catch (err: any) {
        toast.error(err?.message || 'Simulation failed');
      } finally {
        setPending(false);
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [payload]);

  function set<K extends keyof SimulationInput>(key: K, value: SimulationInput[K]) {
    setInput((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    const name = await promptDialog({ title: 'Save scenario', description: 'A short name; it appears as a chip next time.', confirmText: 'Save' } as any);
    if (!name) return;
    try {
      await api.capacity.saveScenario(name.trim().slice(0, 40), payload);
      toast.success('Scenario saved');
      onScenariosChange();
    } catch (err: any) {
      toast.error(err?.message || 'Could not save');
    }
  }

  return (
    <Panel
      title="Simulation"
      description="Move the inputs; every bar is recomputed from the measured baseline and the per-project costs. The saturating resource is the one that gives out first."
      actions={
        <Button size="sm" variant="outline" onClick={save}>
          Save scenario
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Object.entries(overview.presets).map(([key, preset]) => (
          <button
            key={key}
            type="button"
            onClick={() => setInput(preset)}
            className="rounded-full border px-2.5 py-1 text-xs hover:bg-accent"
          >
            {PRESET_LABELS[key] ?? key}
          </button>
        ))}
        {Object.entries(scenarios).map(([name, preset]) => (
          <button
            key={`s-${name}`}
            type="button"
            onClick={() => setInput(preset)}
            className="rounded-full border border-primary/40 px-2.5 py-1 text-xs hover:bg-accent"
            title="Saved scenario"
          >
            {name}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          {FIELDS.map((f) => {
            const value = Number(input[f.key] ?? 0);
            return (
              <label key={f.key} className="block text-xs">
                <span className="flex items-center justify-between text-muted-foreground">
                  <span>{f.label}</span>
                  <span className="tabular-nums text-foreground">{f.format ? f.format(value) : value}</span>
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={value}
                    onChange={(e) => set(f.key, Number(e.target.value) as never)}
                    className="w-full accent-[hsl(var(--primary))]"
                    aria-label={f.label}
                  />
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={value}
                    onChange={(e) => set(f.key, Number(e.target.value) as never)}
                    className="h-7 w-24 rounded-md border bg-background px-2 text-right text-xs tabular-nums"
                    aria-label={`${f.label} (number)`}
                  />
                </span>
              </label>
            );
          })}
          <label className="block text-xs">
            <span className="text-muted-foreground">Postgres max_connections (override, blank = measured)</span>
            <input
              type="number"
              min={0}
              step={10}
              value={pgCeiling}
              onChange={(e) => setPgCeiling(e.target.value === '' ? '' : Number(e.target.value))}
              className="mt-1 h-7 w-32 rounded-md border bg-background px-2 text-right text-xs tabular-nums"
            />
          </label>
        </div>

        <div className={cn('space-y-3 transition-opacity', pending && 'opacity-60')}>
          {result ? (
            <>
              <div
                className={cn(
                  'rounded-lg border p-3 text-sm',
                  result.fits ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10',
                )}
              >
                <div className="font-medium">{result.fits ? 'Fits within every target' : 'Over target'}</div>
                <p className="mt-1 text-xs text-muted-foreground">{result.nextStep}</p>
              </div>
              <ul className="space-y-2.5">
                {result.resources.map((r) => {
                  const tone = utilizationTone(r.utilization, r.target);
                  const first = r.key === result.firstSaturated;
                  return (
                    <li key={r.key} className={cn('rounded-md px-2 py-1.5', first && 'bg-muted/50 ring-1 ring-border')}>
                      <div className="flex items-center justify-between text-xs">
                        <span className={cn('font-medium', first && 'text-foreground')}>
                          {r.label}
                          {first && <span className="ml-1.5 rounded bg-foreground/10 px-1 text-[10px] uppercase">first</span>}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {fmtUnit(r.usage, r.unit)} / {fmtUnit(r.ceiling, r.unit)} · {Math.round(r.utilization * 100)} %
                          {r.saturatesAt !== null && <> · full at ~{r.saturatesAt.toLocaleString()} projects</>}
                        </span>
                      </div>
                      <CapacityMeter utilization={r.utilization} target={r.target} className="mt-1" label={`${r.label} ${Math.round(r.utilization * 100)} %`} />
                      <span className="sr-only">{tone}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="h-40 animate-pulse rounded-lg bg-muted/30" />
          )}
        </div>
      </div>
    </Panel>
  );
}
