/**
 * Agent Creation — strict Drizzle schema (new tables only).
 *
 * Relations:
 *   projects ──1:N──> agents ──1:N──> agent_versions
 *   agents ──1:N──> agent_runs ──N:1──> chat_threads (from agent-memory schema)
 *   agent_runs ──N:1──> agent_versions
 *
 * FK wiring deferred to landing commit:
 *   chat_threads.agent_id → agents.id  (currently a loose text ref in agent-memory.ts;
 *   adding the real FK requires importing agents here, which would create a cycle.
 *   The service layer enforces this invariant; a migration will add the constraint later.)
 *
 * agent_tool_calls.run_id → agent_runs.id  (loose text ref in agent-memory.ts;
 *   FK will be added in a follow-up migration once both tables exist.)
 */
import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { projects } from './_refs';
import { chatThreads } from './agent-memory';

// ── Enums ────────────────────────────────────────────────

export const agentStatus = pgEnum('agent_status', [
  'draft',
  'active',
  'archived',
]);

export const agentProvider = pgEnum('agent_provider', [
  'openai',
  'nebius-private',
  'ollama',
]);

export const agentRunStatus = pgEnum('agent_run_status', [
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const agentToolRisk = pgEnum('agent_tool_risk', [
  'low',
  'medium',
  'high',
]);

// ── agents ───────────────────────────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Denormalized from the project; makes team-scoped queries cheaper.
    teamId: text('team_id').notNull(),

    name: varchar('name', { length: 256 }).notNull(),
    slug: varchar('slug', { length: 256 }).notNull(),
    description: text('description'),
    status: agentStatus('status').notNull().default('draft'),

    // Points to the active AgentVersion. Null until the first version is
    // published; updated transactionally when a new version is promoted.
    currentVersionId: text('current_version_id'),

    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    slugUnique: uniqueIndex('agents_project_slug_uq').on(t.projectId, t.slug),
    projectStatusIdx: index('agents_project_status_idx').on(
      t.projectId,
      t.status,
    ),
  }),
);

// ── agent_versions ───────────────────────────────────────

export const agentVersions = pgTable(
  'agent_versions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // Monotonically increasing per agent; bumped by the service on creation.
    version: integer('version').notNull(),

    systemPrompt: text('system_prompt').notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    provider: agentProvider('provider').notNull().default('openai'),
    temperature: real('temperature').notNull().default(0.7),
    maxTokens: integer('max_tokens').notNull().default(4096),
    maxSteps: integer('max_steps').notNull().default(10),

    // Serialised tool IDs (references agent_tools.tool_id, not enforced via FK).
    toolsConfig: jsonb('tools_config')
      .$type<{ toolIds: string[]; [k: string]: unknown }>()
      .notNull()
      .default({ toolIds: [] }),
    // Provider-specific overrides (e.g. base URL, API key ref, headers).
    modelConfig: jsonb('model_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    versionUnique: uniqueIndex('agent_versions_agent_version_uq').on(
      t.agentId,
      t.version,
    ),
    agentIdx: index('agent_versions_agent_idx').on(t.agentId),
  }),
);

// ── agent_tools ──────────────────────────────────────────
// Tool catalogue / registry — platform-wide, not project-scoped.
// Seeded at startup; runtime checks agent_tools for each tool call.

export const agentTools = pgTable(
  'agent_tools',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Stable identifier used in toolsConfig and policy decisions.
    toolId: varchar('tool_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 256 }).notNull(),
    description: text('description'),
    inputSchema: jsonb('input_schema')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
    risk: agentToolRisk('risk').notNull().default('low'),
    // Mutating tools require explicit opt-in via env / project policy.
    mutating: boolean('mutating').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    toolIdUnique: uniqueIndex('agent_tools_tool_id_uq').on(t.toolId),
    enabledIdx: index('agent_tools_enabled_idx').on(t.enabled),
  }),
);

// ── agent_runs ───────────────────────────────────────────

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    agentVersionId: text('agent_version_id')
      .notNull()
      .references(() => agentVersions.id, { onDelete: 'restrict' }),
    // Cross-schema FK: agent_runs.thread_id → chat_threads.id
    threadId: text('thread_id').references(() => chatThreads.id, {
      onDelete: 'set null',
    }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    status: agentRunStatus('status').notNull().default('running'),
    stepCount: integer('step_count').notNull().default(0),
    latencyMs: integer('latency_ms'),
    errorCode: varchar('error_code', { length: 64 }),
    error: text('error'),

    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { precision: 3 }),
  },
  (t) => ({
    projectIdx: index('agent_runs_project_idx').on(t.projectId),
    agentStatusIdx: index('agent_runs_agent_status_idx').on(
      t.agentId,
      t.status,
    ),
    threadIdx: index('agent_runs_thread_idx').on(t.threadId),
  }),
);

// ── Relations ────────────────────────────────────────────

export const agentsRelations = relations(agents, ({ many }) => ({
  versions: many(agentVersions),
  runs: many(agentRuns),
}));

export const agentVersionsRelations = relations(
  agentVersions,
  ({ one, many }) => ({
    agent: one(agents, {
      fields: [agentVersions.agentId],
      references: [agents.id],
    }),
    runs: many(agentRuns),
  }),
);

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  agent: one(agents, {
    fields: [agentRuns.agentId],
    references: [agents.id],
  }),
  version: one(agentVersions, {
    fields: [agentRuns.agentVersionId],
    references: [agentVersions.id],
  }),
  thread: one(chatThreads, {
    fields: [agentRuns.threadId],
    references: [chatThreads.id],
  }),
}));

// ── Inferred types ───────────────────────────────────────

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type NewAgentVersion = typeof agentVersions.$inferInsert;
export type AgentTool = typeof agentTools.$inferSelect;
export type NewAgentTool = typeof agentTools.$inferInsert;
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
