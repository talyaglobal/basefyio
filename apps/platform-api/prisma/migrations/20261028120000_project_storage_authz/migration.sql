-- How the Supabase-compatible storage facade authorises object access for a
-- project: 'presets' (StoragePolicy access rules) or 'rls' (policies on
-- storage.objects in the project database). Additive only; production applies
-- schema.prisma through `prisma db push` at container start.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "storage_authz" TEXT NOT NULL DEFAULT 'presets';
