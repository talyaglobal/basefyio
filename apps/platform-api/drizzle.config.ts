import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit config for the NEW tables only.
 *
 * Migrations are written to a separate folder so they never collide with the
 * Prisma migration history. Prisma remains the source of truth for all existing
 * tables; drizzle-kit only generates DDL for the tables under src/db/drizzle/schema.
 *
 * IMPORTANT: when running `drizzle-kit generate`, the `_refs` anchor tables
 * (projects, embedding_records) must be filtered out of the diff — they are owned
 * by Prisma. Use `tablesFilter` to scope generation to the new tables.
 */
export default {
  schema: './src/db/drizzle/schema/index.ts',
  out: './src/db/drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Only manage the new tables; Prisma owns everything else.
  tablesFilter: [
    // RAG
    'rag_documents',
    'rag_chunks',
    'rag_index_jobs',
    // Agent memory + messaging
    'chat_threads',
    'chat_messages',
    'agent_memory',
    'agent_tool_calls',
    'agent_policy_events',
    // Agent creation
    'agents',
    'agent_versions',
    'agent_tools',
    'agent_runs',
    'agent_run_attachments',
    'agent_version_data_sources',
  ],
  verbose: true,
  strict: true,
} satisfies Config;
