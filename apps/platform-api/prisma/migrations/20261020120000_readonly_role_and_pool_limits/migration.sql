-- Read-only companion role per project and per-database pooler limits.
-- Additive only. Production applies schema.prisma through `prisma db push` at
-- container start; this file records the change for history.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "db_readonly_user" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "db_readonly_password" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "max_db_connections" INTEGER;

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "max_db_connections" INTEGER;
