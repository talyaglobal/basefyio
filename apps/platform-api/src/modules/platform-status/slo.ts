/**
 * The arithmetic behind the status page, kept free of Prisma and clocks so
 * it can be tested against hand counts.
 *
 * A minute is "down" for a probe when the majority of the vantage points
 * that reported in that minute failed. Availability is observed minutes
 * minus down minutes over observed minutes; an unobserved minute (the
 * prober itself was off) is neither up nor down and does not count.
 */

export const PROBES = ['api', 'dashboard', 'auth', 'database', 'storage', 'realtime'] as const;
export type ProbeName = (typeof PROBES)[number];

/** Targets per calendar month, as the SLA defines them. */
export const SLO_TARGET_PCT: Record<ProbeName, number> = {
  api: 99.97,
  dashboard: 99.9,
  auth: 99.97,
  database: 99.97,
  storage: 99.9,
  realtime: 99.9,
};

export const API_LATENCY_P95_TARGET_MS = 300;
export const ERROR_RATE_TARGET_PCT = 0.1;

export interface SampleLike {
  ts: Date;
  probe: string;
  vantage: string;
  ok: boolean;
  latencyMs?: number | null;
}

export interface MinuteVerdict {
  /** Minute start, UTC, as epoch ms. */
  minute: number;
  down: boolean;
  /** Vantage points that reported in this minute. */
  reporters: number;
  failing: number;
}

/** Group samples of one probe into minutes and decide each one by majority. */
export function minuteVerdicts(samples: SampleLike[]): MinuteVerdict[] {
  const byMinute = new Map<number, Map<string, boolean>>();
  for (const s of samples) {
    const minute = Math.floor(s.ts.getTime() / 60_000) * 60_000;
    let vantages = byMinute.get(minute);
    if (!vantages) {
      vantages = new Map();
      byMinute.set(minute, vantages);
    }
    // Several samples from one vantage point in a minute: it counts as failing
    // only when every one of them failed, so one slow probe does not flip the minute.
    const prev = vantages.get(s.vantage);
    vantages.set(s.vantage, prev === undefined ? s.ok : prev || s.ok);
  }
  const out: MinuteVerdict[] = [];
  for (const [minute, vantages] of byMinute) {
    const reporters = vantages.size;
    let failing = 0;
    for (const ok of vantages.values()) if (!ok) failing++;
    out.push({ minute, reporters, failing, down: failing * 2 > reporters });
  }
  return out.sort((a, b) => a.minute - b.minute);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

export interface WindowSummary {
  totalMinutes: number;
  downMinutes: number;
  p95LatencyMs: number | null;
}

/** One day's roll-up for one probe from its samples. */
export function summarise(samples: SampleLike[]): WindowSummary {
  const verdicts = minuteVerdicts(samples);
  const latencies = samples.filter((s) => s.ok && typeof s.latencyMs === 'number').map((s) => s.latencyMs as number);
  return {
    totalMinutes: verdicts.length,
    downMinutes: verdicts.filter((v) => v.down).length,
    p95LatencyMs: percentile(latencies, 95),
  };
}

export function availabilityPct(totalMinutes: number, downMinutes: number): number | null {
  if (totalMinutes <= 0) return null;
  return Math.round(((totalMinutes - downMinutes) / totalMinutes) * 100_000) / 1_000;
}

/** Minutes a target allows to be down over a window of `windowMinutes`. */
export function errorBudgetMinutes(targetPct: number, windowMinutes: number): number {
  return Math.round(((100 - targetPct) / 100) * windowMinutes * 100) / 100;
}

/**
 * Burn rate: the share of the whole-month budget spent in the last `hours`,
 * relative to what an even spend would be. 1 = on track to use exactly the
 * budget; 14.4 over an hour means the month's budget is gone in ~2 days.
 */
export function burnRate(downMinutesInWindow: number, hours: number, targetPct: number, monthDays = 30): number {
  const budgetPerHour = errorBudgetMinutes(targetPct, monthDays * 24 * 60) / (monthDays * 24);
  if (budgetPerHour <= 0) return 0;
  return Math.round((downMinutesInWindow / hours / budgetPerHour) * 100) / 100;
}

/** Share of 5xx answers in a counter delta, as a percentage with two decimals. */
export function errorRatePct(total: number, errors: number): number | null {
  if (total <= 0) return null;
  return Math.round((errors / total) * 10_000) / 100;
}

/** Minutes in a calendar month, for the budget shown on the page. */
export function minutesInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate() * 24 * 60;
}
