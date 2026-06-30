import type { CitationResult } from '../../../db/drizzle/schema/agent-attachments';

export const TOOL_ADAPTERS_TOKEN = 'TOOL_ADAPTERS' as const;

export type AttachmentKind = 'rag_citation' | 'sql_result' | 'http_response' | 'file';

export interface AttachmentPayload {
  kind: AttachmentKind;
  content: Record<string, unknown>;
}

export interface ToolAdapterContext {
  projectId: string;
  runId: string;
  step: number;
  /** LLM-assigned tool_call_id for correlation with the SSE event. */
  toolCallId: string;
}

export interface ToolAdapterResult {
  /** JSON-serialisable output returned to the LLM as the tool message. */
  output: Record<string, unknown>;
  /** Optional attachments persisted to agent_run_attachments. */
  attachments?: AttachmentPayload[];
  /** Citations extracted from the result for the SSE `citation` event. */
  citations?: CitationResult[];
}

export interface ToolAdapter {
  readonly toolId: string;
  execute(
    input: Record<string, unknown>,
    ctx: ToolAdapterContext,
  ): Promise<ToolAdapterResult>;
}
