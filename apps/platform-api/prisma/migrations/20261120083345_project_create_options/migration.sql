-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "auto_grant_new_tables" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "compute_tier" TEXT NOT NULL DEFAULT 'shared',
ADD COLUMN     "data_api_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "region" TEXT NOT NULL DEFAULT 'eu-central',
ADD COLUMN     "rls_on_new_tables" BOOLEAN NOT NULL DEFAULT false;
