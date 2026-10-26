'use client';

import { cn } from '@/lib/utils';

/** Severity by utilization against the target: good below 70 % of the target, warning up to the target, critical beyond. */
export function utilizationTone(utilization: number, target: number): 'good' | 'warning' | 'critical' {
  if (utilization >= target) return 'critical';
  if (utilization >= target * 0.7) return 'warning';
  return 'good';
}

const FILL: Record<'good' | 'warning' | 'critical', string> = {
  good: 'bg-primary',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
};
const TRACK: Record<'good' | 'warning' | 'critical', string> = {
  good: 'bg-primary/15',
  warning: 'bg-amber-500/15',
  critical: 'bg-red-500/15',
};

/**
 * A ratio against a limit: a thin bar, the unfilled track a lighter step of the
 * same hue, a hairline tick at the target. The value is written beside it so the
 * colour never carries the number alone.
 */
export function CapacityMeter({
  utilization,
  target,
  className,
  label,
}: {
  utilization: number;
  target: number;
  className?: string;
  label?: string;
}) {
  const tone = utilizationTone(utilization, target);
  const width = Math.min(100, Math.max(0, utilization * 100));
  return (
    <div className={cn('relative h-2 w-full overflow-hidden rounded-full', TRACK[tone], className)} role="img" aria-label={label}>
      <div className={cn('h-full rounded-r-full', FILL[tone])} style={{ width: `${width}%` }} />
      <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${Math.min(100, target * 100)}%` }} aria-hidden="true" />
    </div>
  );
}

/** A 24-hour sparkline in the de-emphasis grey with the latest point in the accent. */
export function Sparkline({
  points,
  max,
  className,
  label,
}: {
  points: Array<{ ts: string; value: number | null }>;
  max?: number;
  className?: string;
  label?: string;
}) {
  const w = 160;
  const h = 28;
  const values = points.map((p) => p.value);
  const present = values.filter((v): v is number => v !== null);
  if (present.length < 2) {
    return <div className={cn('h-7 w-40 text-[10px] text-muted-foreground', className)}>no history yet</div>;
  }
  const top = max && max > 0 ? max : Math.max(...present) || 1;
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const y = (v: number) => h - 2 - Math.min(1, Math.max(0, v / top)) * (h - 4);
  let d = '';
  let last: { x: number; y: number } | null = null;
  values.forEach((v, i) => {
    if (v === null) return;
    const px = x(i);
    const py = y(v);
    d += d && last ? ` L ${px.toFixed(1)} ${py.toFixed(1)}` : ` M ${px.toFixed(1)} ${py.toFixed(1)}`;
    last = { x: px, y: py };
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('h-7 w-40', className)} role="img" aria-label={label}>
      <path d={d.trim()} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="text-muted-foreground/60" />
      {last && <circle cx={(last as { x: number }).x} cy={(last as { y: number }).y} r="4" className="fill-primary stroke-background" strokeWidth="2" />}
    </svg>
  );
}

export function fmtUnit(value: number, unit: string): string {
  if (unit === 'MB') return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
  if (unit === 'GB') return `${value.toFixed(value >= 100 ? 0 : 1)} GB`;
  if (unit === 'cores') return `${value.toFixed(2)} cores`;
  if (unit === 'req/s') return `${value.toFixed(value >= 10 ? 0 : 2)} req/s`;
  return `${Math.round(value)} ${unit}`;
}
