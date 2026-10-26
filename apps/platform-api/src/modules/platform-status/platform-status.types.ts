import type { ProbeName } from './slo';

export type ComponentState = 'operational' | 'degraded' | 'down' | 'unknown';

export interface DayFigure {
  /** YYYY-MM-DD, UTC. */
  day: string;
  availabilityPct: number | null;
  downMinutes: number;
  totalMinutes: number;
  /** Set on the days of a month that have not happened yet. */
  future?: boolean;
}

export interface ComponentStatus {
  probe: ProbeName;
  label: string;
  /** What the probe exercises, one line each, as the status page lists it. */
  covers: string[];
  state: ComponentState;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  targetPct: number;
  month: {
    availabilityPct: number | null;
    downMinutes: number;
    observedMinutes: number;
    budgetMinutes: number;
    remainingMinutes: number;
  };
  last30d: { availabilityPct: number | null; downMinutes: number };
  last90d: { availabilityPct: number | null; downMinutes: number };
  /** Oldest first, 90 entries, days without observations have null availability. */
  days: DayFigure[];
}

export interface IncidentUpdate {
  ts: string;
  status: string;
  text: string;
}

export interface IncidentView {
  id: string;
  title: string;
  status: 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';
  impact: 'NONE' | 'MINOR' | 'MAJOR' | 'CRITICAL';
  components: string[];
  startedAt: string;
  resolvedAt: string | null;
  updates: IncidentUpdate[];
  postmortem: string | null;
  excludedFromSlo: boolean;
  auto: boolean;
}

export interface PublicStatus {
  generatedAt: string;
  domain: string;
  overall: ComponentState;
  components: ComponentStatus[];
  incidents: { open: IncidentView[]; recent: IncidentView[] };
  maintenance: IncidentView[];
  /** Parts of the service without a probe; their state comes from open incidents. */
  tracked: TrackedComponent[];
  /** Months with recorded history ("2026-10"), oldest first, the current month included. */
  months: string[];
  /** Whether any probe has reported in the last 5 minutes; false means the figures are stale. */
  live: boolean;
  vantages: string[];
}

/** A component the status page shows without a probe behind it: provisioning, backups, billing, … */
export interface TrackedComponent {
  id: string;
  label: string;
  covers: string[];
  state: ComponentState;
}

export interface MonthComponent {
  probe: ProbeName;
  label: string;
  targetPct: number;
  availabilityPct: number | null;
  downMinutes: number;
  observedMinutes: number;
  /** The worst daily p95 of the month. */
  p95LatencyMs: number | null;
  /** Whether the month met its target; null while nothing was observed. */
  met: boolean | null;
  incidentCount: number;
  /** One entry per calendar day of the month, oldest first. */
  days: DayFigure[];
}

/** One calendar month of the status page's history: GET /api/platform-status/history?month=YYYY-MM. */
export interface StatusHistory {
  month: string;
  from: string;
  to: string;
  /** True once the month has ended and its figures are final. */
  closed: boolean;
  components: MonthComponent[];
  /** Every incident that started in the month, newest first, maintenance included. */
  incidents: IncidentView[];
  months: string[];
  prevMonth: string | null;
  nextMonth: string | null;
}

export interface ProbeDetailRow {
  probe: ProbeName;
  vantage: string;
  ts: string;
  ok: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  detail: string | null;
}

export interface ConsoleStatus extends PublicStatus {
  burn: Record<ProbeName, { h1: number; h6: number; h24: number }>;
  apiLatencyP95Ms: number | null;
  errorRatePct: number | null;
  deploys: Array<{ id: string; imageTag: string; startedAt: string; note: string | null }>;
  probes: ProbeDetailRow[];
  events: Array<{ id: string; source: string; kind: string; severity: string; title: string; occurredAt: string }>;
  enabled: boolean;
  tokenConfigured: boolean;
  canary: { projectId: string | null; configured: boolean };
  subscribers: { confirmed: number; pending: number };
  /** Everything an incident may list as affected: the probes and the tracked components. */
  componentOptions: Array<{ id: string; label: string }>;
}
