/** Mirrors apps/platform-api/src/modules/platform-status/platform-status.types.ts. */

export type ProbeName = 'api' | 'dashboard' | 'auth' | 'database' | 'storage' | 'realtime';
export type ComponentState = 'operational' | 'degraded' | 'down' | 'unknown';

export interface DayFigure {
  day: string;
  availabilityPct: number | null;
  downMinutes: number;
  totalMinutes: number;
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

export type IncidentStatus = 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';
export type IncidentImpact = 'NONE' | 'MINOR' | 'MAJOR' | 'CRITICAL';

export interface IncidentView {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
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
  tracked: Array<{ id: string; label: string; covers: string[]; state: ComponentState }>;
  /** Months with recorded history ("2026-10"), oldest first. */
  months: string[];
  live: boolean;
  vantages: string[];
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

export interface IncidentInput {
  title: string;
  status?: IncidentStatus;
  impact?: IncidentImpact;
  components?: string[];
  startedAt?: string;
  excludedFromSlo?: boolean;
  text?: string;
}
