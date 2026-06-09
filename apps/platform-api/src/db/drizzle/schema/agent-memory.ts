/**
 * Agent chat + memory — strict Drizzle schema (new tables only).
 *
 * Stores conversation threads, individual messages, and derived agent memory.
 * Chat memory lives in THESE Postgres tables (not the out-of-scope cold
 * object-storage gateway). Long-term memory entries link to the existing
 * embedding pipeline via `embedding_record_id`, so memory is retrievable by the
 * same cosine search as RAG chunks.
 *
 * `agent_id` is a nullable text column (no FK yet): the agent table is defined
 * by the Agent Creation module and each agent gets its own spec. The FK will be
 * added when that schema lands — kept loose here to avoid pre-committing to a
 * shape that module owns.
 *
 * Relations:
 *   projects (Prisma) ──1:N──> chat_threads ──1:N──> chat_messages
 *   projects (Prisma) ──1:N──> agent_memory ──N:1──> embedding_records (Prisma)
 *   agent_memory ──N:1(optional)──> chat_threads
 */
import {
  pgTable,
  text,
  integer,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { projects, embeddingRecords } from './_refs';

export const chatRole = pgEnum('chat_role', [
  'system',
  'user',
  'assistant',
  'tool',
]);

export const agentMemoryKind = pgEnum('agent_memory_kind', [
  'short_term', // working memory for the current thread
  'long_term', // durable facts, embedded for retrieval
  'summary', // rolled-up thread summary
]);

export interface ChatMessageMetadata {
  /** Tool name when role = 'tool'. */
  toolName?: string;
  /** Provider tool-call id, for linking a tool result to its request. */
  toolCallId?: string;
  [k: string]: unknown;
}

// ── chat_threads ─────────────────────────────────────────
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Owning agent; FK added when the agent schema lands. */
    agentId: text('agent_id'),
    title: varchar('title', { length: 512 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    projectIdx: index('chat_threads_project_idx').on(t.projectId),
    agentIdx: index('chat_threads_agent_idx').on(t.agentId),
  }),
);

// ── chat_messages ────────────────────────────────────────
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    // Denormalized for project-scoped isolation.
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: chatRole('role').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count'),
    metadata: jsonb('metadata').$type<ChatMessageMetadata>(),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index('chat_messages_thread_idx').on(t.threadId, t.createdAt),
    projectIdx: index('chat_messages_project_idx').on(t.projectId),
  }),
);

// ── agent_memory ─────────────────────────────────────────
export const agentMemory = pgTable(
  'agent_memory',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentId: text('agent_id'),
    threadId: text('thread_id').references(() => chatThreads.id, {
      onDelete: 'set null',
    }),
    kind: agentMemoryKind('kind').notNull().default('long_term'),
    content: text('content').notNull(),
    // Range-constrained 0–100 (also validated in the repository before write).
    importance: integer('importance').notNull().default(0),
    // Retrievable via the existing cosine search (vector in embeddings_store).
    embeddingRecordId: text('embedding_record_id').references(
      () => embeddingRecords.id,
      { onDelete: 'set null' },
    ),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { precision: 3 }),
  },
  (t) => ({
    projectKindIdx: index('agent_memory_project_kind_idx').on(
      t.projectId,
      t.kind,
    ),
    agentIdx: index('agent_memory_agent_idx').on(t.agentId),
    embeddingIdx: index('agent_memory_embedding_idx').on(t.embeddingRecordId),
    // Partial index to make the expiry cleanup job cheap.
    expiresIdx: index('agent_memory_expires_idx')
      .on(t.projectId, t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
    importanceChk: check(
      'agent_memory_importance_chk',
      sql`${t.importance} >= 0 AND ${t.importance} <= 100`,
    ),
  }),
);

export const agentToolCallStatus = pgEnum('agent_tool_call_status', [
  'allowed', // policy passed, execution pending
  'denied',  // policy blocked
  'success', // executed and returned a result
  'failed',  // execution threw an error
]);

export const agentPolicyDecision = pgEnum('agent_policy_decision', [
  'allow',
  'deny',
]);

// ── agent_tool_calls ─────────────────────────────────────
// runId is a loose text ref — FK to agent_runs added when Module 3 lands.
export const agentToolCalls = pgTable(
  'agent_tool_calls',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: text('run_id'),
    threadId: text('thread_id').references(() => chatThreads.id, {
      onDelete: 'cascade',
    }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    toolId: varchar('tool_id', { length: 128 }).notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    status: agentToolCallStatus('status').notNull(),
    latencyMs: integer('latency_ms'),
    deniedReason: text('denied_reason'),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('agent_tool_calls_project_idx').on(t.projectId),
    threadIdx: index('agent_tool_calls_thread_idx').on(t.threadId),
    runIdx: index('agent_tool_calls_run_idx').on(t.runId),
  }),
);

// ── agent_policy_events ──────────────────────────────────
export const agentPolicyEvents = pgTable(
  'agent_policy_events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: text('run_id'),
    toolCallId: text('tool_call_id').references(() => agentToolCalls.id, {
      onDelete: 'set null',
    }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    decision: agentPolicyDecision('decision').notNull(),
    reasonCode: varchar('reason_code', { length: 64 }),
    matchedRule: text('matched_rule'),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('agent_policy_events_project_idx').on(t.projectId),
    toolCallIdx: index('agent_policy_events_tool_call_idx').on(t.toolCallId),
    runIdx: index('agent_policy_events_run_idx').on(t.runId),
  }),
);

// ── Relations ────────────────────────────────────────────
export const chatThreadsRelations = relations(chatThreads, ({ many }) => ({
  messages: many(chatMessages),
  toolCalls: many(agentToolCalls),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  thread: one(chatThreads, {
    fields: [chatMessages.threadId],
    references: [chatThreads.id],
  }),
}));

export const agentMemoryRelations = relations(agentMemory, ({ one }) => ({
  thread: one(chatThreads, {
    fields: [agentMemory.threadId],
    references: [chatThreads.id],
  }),
}));

export const agentToolCallsRelations = relations(agentToolCalls, ({ one, many }) => ({
  thread: one(chatThreads, {
    fields: [agentToolCalls.threadId],
    references: [chatThreads.id],
  }),
  policyEvents: many(agentPolicyEvents),
}));

export const agentPolicyEventsRelations = relations(agentPolicyEvents, ({ one }) => ({
  toolCall: one(agentToolCalls, {
    fields: [agentPolicyEvents.toolCallId],
    references: [agentToolCalls.id],
  }),
}));

// ── Inferred types ───────────────────────────────────────
export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type AgentMemory = typeof agentMemory.$inferSelect;
export type NewAgentMemory = typeof agentMemory.$inferInsert;
export type AgentToolCall = typeof agentToolCalls.$inferSelect;
export type NewAgentToolCall = typeof agentToolCalls.$inferInsert;
export type AgentPolicyEvent = typeof agentPolicyEvents.$inferSelect;
export type NewAgentPolicyEvent = typeof agentPolicyEvents.$inferInsert;
