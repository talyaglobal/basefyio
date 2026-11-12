/** Automation flow definition (re-implemented from the askin flow concept). */

export type FlowTriggerType = 'manual' | 'webhook' | 'schedule';

export interface FlowTrigger {
  type: FlowTriggerType;
  /** webhook: legacy path segment, kept for flows that stored it. The flow's
   *  own URL is the webhookId on the row (see FlowsService.toPublicFlow). */
  webhookPath?: string;
  /** schedule: a 5-field cron expression (minute hour day-of-month month day-of-week). */
  cron?: string;
  /** schedule: IANA time zone the cron is read in. Defaults to UTC. */
  timezone?: string;
}

export type FlowActionType =
  | 'log'
  | 'http.request'
  | 'db.select'
  | 'db.insert'
  | 'db.update';

export type FlowHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface FlowAction {
  /** Stable id, assigned on save. Lets an edit keep masked header values. */
  id?: string;
  /** Optional label; also addressable in templates as {{steps.<name>...}}. */
  name?: string;
  type: FlowActionType;
  /** log: */
  message?: string;
  /** http.request: */
  method?: FlowHttpMethod;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** http.request: follow 3xx redirects (each hop re-checked). Default true. */
  followRedirects?: boolean;
  /** db.*: the table in the project's public schema. */
  table?: string;
  /** db.select / db.update: filters in the REST form, e.g. { "id": "eq.{{input.id}}" }. */
  filters?: Record<string, string>;
  /** db.select: column list, e.g. "id,email". Default "*". */
  select?: string;
  /** db.select: max rows (1-1000). Default 100. */
  limit?: number;
  /** db.insert / db.update: the row (or rows, insert only) to write. */
  values?: Record<string, unknown> | Record<string, unknown>[];
  /** Per-step time limit in milliseconds (http.request, db.*). */
  timeoutMs?: number;
  /** Re-run THIS step (never the steps before it) up to this many times on failure. */
  retries?: number;
  /** Wait before the first retry; doubles on each further retry. */
  retryDelayMs?: number;
  /** continue the flow even if this action fails. */
  continueOnError?: boolean;
}

/** Limits that apply to every run of a flow. All optional; see FLOW_LIMITS. */
export interface FlowOptions {
  /** Default per-step timeout for steps that do not set their own. */
  timeoutMs?: number;
  /** Default retries for steps that do not set their own. */
  retries?: number;
  /** Default retry delay for steps that do not set their own. */
  retryDelayMs?: number;
  /** Hard limit for a whole run; the run fails when it is exceeded. */
  maxDurationMs?: number;
  /** How many runs of this flow may execute at the same time. Unset = no per-flow cap. */
  maxConcurrentRuns?: number;
}

export interface FlowDefinitionInput {
  name: string;
  trigger: FlowTrigger;
  actions: FlowAction[];
  enabled?: boolean;
  options?: FlowOptions | null;
}

export type FlowRunSource = 'manual' | 'api' | 'webhook' | 'schedule' | 'rerun';

/** One try of a step. A step with retries keeps every attempt. */
export interface FlowStepAttempt {
  attempt: number;
  ok: boolean;
  status?: number;
  detail?: string;
  durationMs: number;
}

export interface FlowStepResult {
  /** Position of the action in the flow. */
  index?: number;
  name?: string;
  type: FlowActionType;
  ok: boolean;
  /** HTTP status of the final response (http.request). */
  status?: number;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Number of tries, 1 when the step was not retried. */
  attempts?: number;
  attemptLog?: FlowStepAttempt[];
  /** http.request: what came back (body truncated for storage). */
  response?: {
    headers: Record<string, string>;
    body: unknown;
    truncated: boolean;
    redirects: string[];
  };
  /** db.*: rows returned or written (truncated for storage). */
  rows?: unknown[];
  rowCount?: number;
  /** Template placeholders that resolved to nothing. */
  warnings?: string[];
  /** true when a failure was tolerated because of continueOnError. */
  continued?: boolean;
}
