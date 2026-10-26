/** The public status payload, as `GET /api/platform-status/public` returns it. */

export type ProbeName = "api" | "dashboard" | "auth" | "database" | "storage" | "realtime";
export type ComponentState = "operational" | "degraded" | "down" | "unknown";

export interface DayFigure {
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
  /** What the probe exercises, one line each. */
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
  status: "INVESTIGATING" | "IDENTIFIED" | "MONITORING" | "RESOLVED";
  impact: "NONE" | "MINOR" | "MAJOR" | "CRITICAL";
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
  live: boolean;
  vantages: string[];
}

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
  p95LatencyMs: number | null;
  met: boolean | null;
  incidentCount: number;
  days: DayFigure[];
}

/** One calendar month of history, as GET /api/platform-status/history?month=YYYY-MM returns it. */
export interface StatusHistory {
  month: string;
  from: string;
  to: string;
  closed: boolean;
  components: MonthComponent[];
  incidents: IncidentView[];
  months: string[];
  prevMonth: string | null;
  nextMonth: string | null;
}
