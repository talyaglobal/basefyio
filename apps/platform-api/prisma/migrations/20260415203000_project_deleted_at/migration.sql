-- Retention clock for soft-deleted projects (24h hard delete uses this, not updatedAt).
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

UPDATE "projects"
SET "deleted_at" = "updated_at"
WHERE "status" = 'DELETED' AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "projects_status_deleted_at_idx" ON "projects"("status", "deleted_at");
