/** Automation flow definition (re-implemented from the askin flow concept). */

export type FlowTriggerType = 'manual' | 'webhook' | 'schedule';

export interface FlowTrigger {
  type: FlowTriggerType;
  /** webhook: the path segment that fires this flow. */
  webhookPath?: string;
  /** schedule: a cron expression (reserved; scheduling wired in a later phase). */
  cron?: string;
}

export type FlowActionType = 'log' | 'http.request';

export interface FlowAction {
  type: FlowActionType;
  /** log: */
  message?: string;
  /** http.request: */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** continue the flow even if this action fails. */
  continueOnError?: boolean;
}

export interface FlowDefinitionInput {
  name: string;
  trigger: FlowTrigger;
  actions: FlowAction[];
  enabled?: boolean;
}

export interface FlowStepResult {
  type: FlowActionType;
  ok: boolean;
  status?: number;
  detail?: string;
}
