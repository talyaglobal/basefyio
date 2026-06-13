export type TriggerType = 'webhook' | 'item.created' | 'item.updated' | 'item.deleted' | 'schedule';
export type ActionType = 'http.post' | 'item.create' | 'item.update' | 'item.delete' | 'log' | 'agent_run';

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
  // agent_run fields
  agentId?: string;
  agentSlug?: string;
  outputKey?: string;      // writes agent output into flow context at this key
  allowMutating?: boolean;
  message?: string;        // user message to send to the agent
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
