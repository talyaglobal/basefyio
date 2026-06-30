-- Phase modules flag: add per-project module feature-flag column.
-- Default '{}' = all modules enabled (backward compatible with existing rows).
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "modules" JSONB NOT NULL DEFAULT '{}';
