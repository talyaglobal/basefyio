/**
 * RAG storage — strict Drizzle schema (new tables only; Prisma untouched).
 *
 * Relations (all explicit FKs):
 *   projects (Prisma) ──1:N──> rag_documents ──1:N──> rag_chunks
 *                       └──1:N──> rag_index_jobs ──N:1──> rag_documents
 *   rag_chunks ──N:1──> rag_chunks (prev_chunk_id, chained overlap)
 *   rag_chunks ──N:1──> embedding_records (Prisma; vector twin in embeddings_store)
 *
 * Source object pointer: rag_documents references an object in the EXISTING
 * MinIO bucket system by (project_id, bucket_name, object_key). Buckets are NOT
 * database rows (they live in MinIO as `bf-{slug}-{name}`), so there is no bucket
 * FK — the invariant is enforced by a UNIQUE(project_id, bucket_name, object_key)
 * index plus an existence check before ingest. The cold object-storage subsystem
 * is out of scope and never referenced here.
 *
 * Metadata strategy: everything queried or enforced is a typed column. Free-form
 * extras go in a single typed jsonb `metadata` column (see RagDocumentMetadata),
 * never as loose untyped blobs.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { projects, embeddingRecords } from './_refs';

// ── Enums ────────────────────────────────────────────────
export const ragDocumentStatus = pgEnum('rag_document_status', [
  'PENDING', // registered, not yet indexed
  'PROCESSING', // an index job is running
  'INDEXED', // chunks + embeddings complete
  'FAILED', // last index job failed
  'STALE', // source object changed; needs reindex
]);

/** The three analysis granularities; `sentence` is the usual sweet spot. */
export const ragGranularity = pgEnum('rag_granularity', [
  'word',
  'sentence',
  'context',
]);

export const ragIndexJobStatus = pgEnum('rag_index_job_status', [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const ragIndexJobKind = pgEnum('rag_index_job_kind', [
  'INDEX', // initial index of one document
  'REINDEX', // forced full reindex
  'REINDEX_INCOMPLETE', // only docs that are not fully INDEXED
]);

// ── Typed metadata contracts (jsonb $type) ───────────────
export interface RagDocumentMetadata {
  /** Original filename, if known. */
  filename?: string;
  /** Arbitrary user labels for filtering at the application layer. */
  labels?: string[];
  /** Source system hint (e.g. "upload", "import"). */
  source?: string;
  [k: string]: unknown;
}

// ── rag_documents ────────────────────────────────────────
export const ragDocuments = pgTable(
  'rag_documents',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    // Source pointer into the existing MinIO bucket system (no bucket FK).
    bucketName: varchar('bucket_name', { length: 63 }).notNull(),
    objectKey: text('object_key').notNull(),

    title: varchar('title', { length: 512 }),
    contentType: varchar('content_type', { length: 128 }),
    // bigint mode avoids JS number precision loss on large objects; the global
    // BigIntSerializationInterceptor handles JSON output.
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
    // SHA-256 of the source bytes. Nullable only briefly: it is set during
    // ingest and MUST be non-null once status reaches INDEXED (invariant tested).
    // A changed hash for the same object flips the existing doc to STALE — it
    // never creates a duplicate row.
    sourceHash: varchar('source_hash', { length: 64 }),

    status: ragDocumentStatus('status').notNull().default('PENDING'),

    // Chunking strategy is stored per-document so re-indexing to find the sweet
    // spot is a re-run, never a schema refactor.
    granularity: ragGranularity('granularity').notNull().default('sentence'),
    chunkSize: integer('chunk_size').notNull().default(1000),
    chunkOverlap: integer('chunk_overlap').notNull().default(200),
    chunkerVersion: varchar('chunker_version', { length: 16 })
      .notNull()
      .default('v1'),
    normalizedFormat: varchar('normalized_format', { length: 32 }),

    chunkCount: integer('chunk_count').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),

    error: text('error'),
    metadata: jsonb('metadata').$type<RagDocumentMetadata>(),

    indexedAt: timestamp('indexed_at', { precision: 3 }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // One document per source object (invariant; replaces a bucket FK).
    objectUnique: uniqueIndex('rag_documents_object_uq').on(
      t.projectId,
      t.bucketName,
      t.objectKey,
    ),
    projectStatusIdx: index('rag_documents_project_status_idx').on(
      t.projectId,
      t.status,
    ),
  }),
);

// ── rag_chunks ───────────────────────────────────────────
export const ragChunks = pgTable(
  'rag_chunks',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    documentId: text('document_id')
      .notNull()
      .references(() => ragDocuments.id, { onDelete: 'cascade' }),
    // Denormalized for strict project-scoped isolation queries + cascade.
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),

    // Chained-overlap offsets into the normalized document text.
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    /** Chars shared with the previous chunk (0 for the first). */
    overlapChars: integer('overlap_chars').notNull().default(0),
    tokenCount: integer('token_count'),

    // Chain link: the previous chunk in reading order (self FK).
    prevChunkId: text('prev_chunk_id').references(
      (): AnyPgColumn => ragChunks.id,
      { onDelete: 'set null' },
    ),

    // Link into the existing embedding pipeline (vector in embeddings_store).
    embeddingRecordId: text('embedding_record_id').references(
      () => embeddingRecords.id,
      { onDelete: 'set null' },
    ),

    createdAt: timestamp('created_at', { precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    docChunkUnique: uniqueIndex('rag_chunks_doc_index_uq').on(
      t.documentId,
      t.chunkIndex,
    ),
    projectIdx: index('rag_chunks_project_idx').on(t.projectId),
    documentIdx: index('rag_chunks_document_idx').on(t.documentId),
    embeddingIdx: index('rag_chunks_embedding_idx').on(t.embeddingRecordId),
  }),
);

// ── rag_index_jobs ───────────────────────────────────────
export const ragIndexJobs = pgTable(
  'rag_index_jobs',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Null for project-wide reindex jobs.
    documentId: text('document_id').references(() => ragDocuments.id, {
      onDelete: 'cascade',
    }),

    kind: ragIndexJobKind('kind').notNull().default('INDEX'),
    status: ragIndexJobStatus('status').notNull().default('QUEUED'),

    /** Idempotency key — the same logical job cannot be enqueued twice. */
    dedupeKey: text('dedupe_key').notNull(),

    attempts: integer('attempts').notNull().default(0),
    totalDocs: integer('total_docs').notNull().default(0),
    processedDocs: integer('processed_docs').notNull().default(0),
    totalChunks: integer('total_chunks').notNull().default(0),

    error: text('error'),
    startedAt: timestamp('started_at', { precision: 3 }),
    finishedAt: timestamp('finished_at', { precision: 3 }),
    createdAt: timestamp('created_at', { precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // Composite so the same logical key in different projects never collides.
    dedupeUnique: uniqueIndex('rag_index_jobs_dedupe_uq').on(
      t.projectId,
      t.dedupeKey,
    ),
    projectStatusIdx: index('rag_index_jobs_project_status_idx').on(
      t.projectId,
      t.status,
    ),
  }),
);

// ── Relations (for the Drizzle relational query API) ─────
export const ragDocumentsRelations = relations(ragDocuments, ({ many }) => ({
  chunks: many(ragChunks),
  jobs: many(ragIndexJobs),
}));

export const ragChunksRelations = relations(ragChunks, ({ one }) => ({
  document: one(ragDocuments, {
    fields: [ragChunks.documentId],
    references: [ragDocuments.id],
  }),
  prev: one(ragChunks, {
    fields: [ragChunks.prevChunkId],
    references: [ragChunks.id],
    relationName: 'chunk_chain',
  }),
}));

export const ragIndexJobsRelations = relations(ragIndexJobs, ({ one }) => ({
  document: one(ragDocuments, {
    fields: [ragIndexJobs.documentId],
    references: [ragDocuments.id],
  }),
}));

// ── Inferred types ───────────────────────────────────────
export type RagDocument = typeof ragDocuments.$inferSelect;
export type NewRagDocument = typeof ragDocuments.$inferInsert;
export type RagChunk = typeof ragChunks.$inferSelect;
export type NewRagChunk = typeof ragChunks.$inferInsert;
export type RagIndexJob = typeof ragIndexJobs.$inferSelect;
export type NewRagIndexJob = typeof ragIndexJobs.$inferInsert;
