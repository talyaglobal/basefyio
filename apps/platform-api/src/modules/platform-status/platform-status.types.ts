import type { ProbeName } from './slo';

export type ComponentState = 'operational' | 'degraded' | 'down' | 'unknown';

export interface DayFigure {
  /** YYYY-MM-DD, UTC. */
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
  /** Whether any probe has reported in the last 5 minutes; false means the figures are stale. */
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
}
