/**
 * Lightweight references to Prisma-owned tables.
 *
 * Drizzle does NOT own or migrate these tables — Prisma does. They are declared
 * here ONLY so the new Drizzle tables can target them with real foreign keys.
 * Never add columns/migrations for these here; treat them as read-only anchors.
 *
 * `projects.id` and `embedding_records.id` are stored as TEXT in Postgres
 * (Prisma `String @id`), so they are modelled as `text` here to match the FK type.
 */
import { pgTable, text } from 'drizzle-orm/pg-core';

/** Prisma-owned `projects` table — FK anchor only. */
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
});

/**
 * Prisma-owned `embedding_records` table — FK anchor only.
 * The actual vector lives in `embeddings_store` (raw SQL, pgvector); a RAG chunk
 * links to its embedding through this metadata twin, reusing the existing
 * embedding pipeline rather than building a parallel vector store.
 */
export const embeddingRecords = pgTable('embedding_records', {
  id: text('id').primaryKey(),
});
