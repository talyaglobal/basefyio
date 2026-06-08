-- Bootstrap pgvector + embedding tables inside a tenant project database.
-- Idempotent — safe to run multiple times on the same database.

-- 1. Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Embedding metadata table
CREATE TABLE IF NOT EXISTS "bf_embeddings" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "content_hash" VARCHAR(64) NOT NULL,
  "namespace"    VARCHAR(128) NOT NULL DEFAULT 'default',
  "content"      TEXT NOT NULL,
  "metadata"     JSONB,
  "token_count"  INTEGER,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "bf_embeddings_hash_ns_key"
  ON "bf_embeddings"("content_hash", "namespace");

CREATE INDEX IF NOT EXISTS "bf_embeddings_namespace_idx"
  ON "bf_embeddings"("namespace");

CREATE INDEX IF NOT EXISTS "bf_embeddings_metadata_idx"
  ON "bf_embeddings" USING gin("metadata");

-- 3. Vector store (separate table so Prisma-unaware code can manage vectors)
CREATE TABLE IF NOT EXISTS "bf_embeddings_store" (
  "id"        UUID PRIMARY KEY REFERENCES "bf_embeddings"("id") ON DELETE CASCADE,
  "embedding" vector(1536) NOT NULL
);

-- HNSW index for fast approximate nearest-neighbor cosine search
CREATE INDEX IF NOT EXISTS "bf_embeddings_store_hnsw_idx"
  ON "bf_embeddings_store"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4. Keyword search index on content column (for hybrid search)
CREATE INDEX IF NOT EXISTS "bf_embeddings_content_trgm_idx"
  ON "bf_embeddings"
  USING gin("content" gin_trgm_ops);

-- 5. Grant access to RLS roles so the public API can read/write embeddings
GRANT SELECT, INSERT, UPDATE, DELETE ON "bf_embeddings" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "bf_embeddings_store" TO authenticated;
GRANT SELECT ON "bf_embeddings" TO anon;
GRANT SELECT ON "bf_embeddings_store" TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON "bf_embeddings" TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON "bf_embeddings_store" TO service_role;
