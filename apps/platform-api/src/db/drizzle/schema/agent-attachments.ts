import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { projects } from './_refs';
import { agentRuns } from './agent-creation';

// ── Enums ─────────────────────────────────────────────────

export const attachmentKind = pgEnum('attachment_kind', [
  'rag_citation',
  'sql_result',
  'http_response',
  'file',
]);

export type AttachmentKind = (typeof attachmentKind.enumValues)[number];

// ── CitationResult ─────────────────────────────────────────
// Serialised into agent_run_attachments.content for rag_citation rows.

export interface CitationResult {
  documentId: string | null;
  chunkId: string;
  chunkIndex: number | null;
  title: string | null;
  score: number;
  text: string | null;
  bucketName?: string | null;
  objectKey?: string | null;
}

// ── agent_run_attachments ──────────────────────────────────

export const agentRunAttachments = pgTable(
  'agent_run_attachments',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Which step of the run produced this attachment.
    step: integer('step').notNull(),
    // Loose ref to agent_tool_calls.id — FK deferred.
    toolCallId: text('tool_call_id'),
    kind: attachmentKind('kind').notNull(),
    // Serialised CitationResult[] for rag_citation, row array for sql_result, etc.
    content: jsonb('content').notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    runStepIdx: index('agent_run_attachments_run_step_idx').on(t.runId, t.step),
    projectIdx: index('agent_run_attachments_project_idx').on(t.projectId),
    toolCallIdx: index('agent_run_attachments_tool_call_idx').on(t.toolCallId),
  }),
);

// ── Relations ──────────────────────────────────────────────

export const agentRunAttachmentsRelations = relations(
  agentRunAttachments,
  ({ one }) => ({
    run: one(agentRuns, {
      fields: [agentRunAttachments.runId],
      references: [agentRuns.id],
    }),
  }),
);

// ── Inferred types ─────────────────────────────────────────

export type AgentRunAttachment = typeof agentRunAttachments.$inferSelect;
export type NewAgentRunAttachment = typeof agentRunAttachments.$inferInsert;
