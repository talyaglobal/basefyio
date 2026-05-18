-- Embedding metadata — Prisma-managed, no vector columns here.
-- The vector itself lives in embeddings_store (raw SQL only).
CREATE TABLE IF NOT EXISTS "embedding_records" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "content_hash"    VARCHAR(64) NOT NULL,
  "entity_type"     VARCHAR(64) NOT NULL,
  "entity_id"       TEXT NOT NULL,
  -- TEXT matches Prisma's String @id on projects and teams tables
  "project_id"      TEXT REFERENCES "projects"("id") ON DELETE CASCADE,
  "team_id"         TEXT REFERENCES "teams"("id") ON DELETE CASCADE,
  "token_count"     INTEGER,
  "embedding_model" VARCHAR(80) NOT NULL DEFAULT 'text-embedding-3-small',
  -- Stores the original text chunk so hydration is a single table scan, not
  -- a fan-out to sql_audit_logs / project_activity_logs / etc.
  "metadata"        JSONB,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  -- Prisma manages @updatedAt in app code; the DB default handles manual inserts.
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "embedding_records_content_hash_key"
  ON "embedding_records"("content_hash");

CREATE INDEX IF NOT EXISTS "embedding_records_entity_idx"
  ON "embedding_records"("entity_type", "entity_id");

CREATE INDEX IF NOT EXISTS "embedding_records_project_idx"
  ON "embedding_records"("project_id", "entity_type");

CREATE INDEX IF NOT EXISTS "embedding_records_team_idx"
  ON "embedding_records"("team_id", "entity_type");

-- Vector store — raw SQL only; Prisma never touches this table directly.
-- id is TEXT (not UUID) to match Prisma's String @id type on embedding_records.
CREATE TABLE IF NOT EXISTS "embeddings_store" (
  "id"        TEXT PRIMARY KEY REFERENCES "embedding_records"("id") ON DELETE CASCADE,
  "embedding" vector(1536) NOT NULL
);

-- HNSW index for sub-10ms approximate nearest-neighbor cosine search.
-- m=16: connectivity (higher = better recall, more memory).
-- ef_construction=64: build quality (higher = better, slower to build).
CREATE INDEX IF NOT EXISTS "embeddings_store_hnsw_idx"
  ON "embeddings_store"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
