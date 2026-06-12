export type TriggerType = 'webhook' | 'item.created' | 'item.updated' | 'item.deleted' | 'schedule';
export type ActionType = 'http.post' | 'item.create' | 'item.update' | 'item.delete' | 'log';

export interface FlowTrigger {
  type: TriggerType;
  entityName?: string;      // for item.* triggers
  cronExpression?: string;  // for schedule triggers
  webhookPath?: string;     // auto-generated for webhook triggers
}

export interface FlowAction {
  type: ActionType;
  entityName?: string;     // for item.* actions
  data?: Record<string, unknown>; // static data or template refs
  url?: string;            // for http.post
  headers?: Record<string, string>;
}

export interface FlowDefinition {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: FlowTrigger;
  actions: FlowAction[];
  createdAt: string;
  updatedAt: string;
}

export interface FlowRunResult {
  flowId: string;
  success: boolean;
  actionsRun: number;
  errors: string[];
  durationMs: number;
}
