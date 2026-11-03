-- Per-project switch for the Supabase-compatible surfaces (auth/v1, storage/v1, the
-- storage catalog). Additive only; production applies schema.prisma through
-- `prisma db push` at container start, and every existing project stays off.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "supabase_compat" BOOLEAN NOT NULL DEFAULT false;
