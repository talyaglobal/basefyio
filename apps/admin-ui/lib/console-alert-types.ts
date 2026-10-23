/** GET /admin/console/alerts — the red badge across the top of the root console. */

export type ConsoleAlertSeverity = 'critical' | 'warning';

/** Something that happened; stays until a root user acknowledges it. */
export interface ConsoleAlert {
  id: string;
  source: string;
  kind: string;
  severity: ConsoleAlertSeverity;
  title: string;
  detail: string | null;
  metadata: unknown;
  occurredAt: string;
}

/** Something true right now; clears itself and cannot be acknowledged. */
export interface ConsoleCondition {
  key: string;
  severity: ConsoleAlertSeverity;
  title: string;
  detail: string;
}

export interface ConsoleAutopilot {
  installed: boolean;
  checkedAt: string | null;
  stale: boolean;
  growthConfigured: boolean;
  growthError: string | null;
  sizeBytes: number | null;
  usedPercent: number | null;
  growAtPercent: number | null;
  maxSizeGb: number | null;
  lastGrowAt: string | null;
}

export interface ConsoleAlertFeed {
  alerts: ConsoleAlert[];
  conditions: ConsoleCondition[];
  autopilot: ConsoleAutopilot;
}
