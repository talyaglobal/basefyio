-- Add tenant-level embedding settings to projects table.
-- pgvector_enabled: tracks whether the project's own DB has vector extension + tables.
-- embedding_api_key: optional per-project OpenAI API key (falls back to platform key).

ALTER TABLE "projects"
  ADD COLUMN "pgvector_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pgvector_enabled_at" TIMESTAMP(3),
  ADD COLUMN "embedding_api_key" TEXT;
