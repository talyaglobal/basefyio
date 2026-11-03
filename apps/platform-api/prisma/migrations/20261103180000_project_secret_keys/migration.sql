-- Additional, hashed server-side keys per project, and when the legacy service key was last used.
-- Additive only; production applies schema.prisma through `prisma db push` at container start.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "service_key_last_used_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "project_secret_keys" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "last4" TEXT NOT NULL,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "project_secret_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_secret_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_secret_keys_key_hash_key" ON "project_secret_keys"("key_hash");
CREATE INDEX IF NOT EXISTS "project_secret_keys_project_id_idx" ON "project_secret_keys"("project_id");
