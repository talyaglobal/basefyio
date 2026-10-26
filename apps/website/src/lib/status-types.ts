/** The public status payload, as `GET /api/platform-status/public` returns it. */

export type ProbeName = "api" | "dashboard" | "auth" | "database" | "storage" | "realtime";
export type ComponentState = "operational" | "degraded" | "down" | "unknown";

export interface DayFigure {
  day: string;
  availabilityPct: number | null;
  downMinutes: number;
  totalMinutes: number;
}

export interface ComponentStatus {
  probe: ProbeName;
  label: string;
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
  live: boolean;
  vantages: string[];
}
