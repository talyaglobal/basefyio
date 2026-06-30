/*
  Warnings:

  - You are about to drop the column `ai_reasons` on the `data_structures` table. All the data in the column will be lost.
  - You are about to drop the column `ai_recommended` on the `data_structures` table. All the data in the column will be lost.
  - You are about to drop the column `embedding_api_key` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `can_manage_billing` on the `team_role_permissions` table. All the data in the column will be lost.
  - You are about to drop the column `can_view_billing` on the `team_role_permissions` table. All the data in the column will be lost.
  - You are about to drop the `billing_accounts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `embedding_records` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `invoice_line_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `invoices` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `migration_archive_files` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `migration_archive_ledgers` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `migration_archives` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `migration_assessments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `migration_consents` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `migration_import_credentials` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `migration_restore_jobs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `plans` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `quickbooks_connection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `quickbooks_sync_log` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `subscriptions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `team_usage` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `usage_records` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "billing_accounts" DROP CONSTRAINT "billing_accounts_team_id_fkey";

-- DropForeignKey
ALTER TABLE "invoice_line_items" DROP CONSTRAINT "invoice_line_items_archive_id_fkey";

-- DropForeignKey
ALTER TABLE "invoice_line_items" DROP CONSTRAINT "invoice_line_items_invoice_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_team_id_fkey";

-- DropForeignKey
ALTER TABLE "migration_archive_files" DROP CONSTRAINT "migration_archive_files_archive_id_fkey";

-- DropForeignKey
ALTER TABLE "migration_archive_ledgers" DROP CONSTRAINT "migration_archive_ledgers_archive_id_fkey";

-- DropForeignKey
ALTER TABLE "migration_archives" DROP CONSTRAINT "migration_archives_project_id_fkey";

-- DropForeignKey
ALTER TABLE "migration_assessments" DROP CONSTRAINT "migration_assessments_archive_id_fkey";

-- DropForeignKey
ALTER TABLE "migration_assessments" DROP CONSTRAINT "migration_assessments_superseded_by_id_fkey";

-- DropForeignKey
ALTER TABLE "migration_consents" DROP CONSTRAINT "migration_consents_archive_id_fkey";

-- DropForeignKey
ALTER TABLE "migration_import_credentials" DROP CONSTRAINT "migration_import_credentials_archive_id_fkey";

-- DropForeignKey
ALTER TABLE "migration_restore_jobs" DROP CONSTRAINT "migration_restore_jobs_archive_id_fkey";

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_team_id_fkey";

-- DropForeignKey
ALTER TABLE "team_usage" DROP CONSTRAINT "team_usage_team_id_fkey";

-- AlterTable
ALTER TABLE "data_structures" DROP COLUMN "ai_reasons",
DROP COLUMN "ai_recommended";

-- AlterTable
ALTER TABLE "projects" DROP COLUMN "embedding_api_key";

-- AlterTable
ALTER TABLE "team_role_permissions" DROP COLUMN "can_manage_billing",
DROP COLUMN "can_view_billing";

-- DropTable
DROP TABLE "billing_accounts";

-- DropTable
DROP TABLE "embedding_records";

-- DropTable
DROP TABLE "invoice_line_items";

-- DropTable
DROP TABLE "invoices";

-- DropTable
DROP TABLE "migration_archive_files";

-- DropTable
DROP TABLE "migration_archive_ledgers";

-- DropTable
DROP TABLE "migration_archives";

-- DropTable
DROP TABLE "migration_assessments";

-- DropTable
DROP TABLE "migration_consents";

-- DropTable
DROP TABLE "migration_import_credentials";

-- DropTable
DROP TABLE "migration_restore_jobs";

-- DropTable
DROP TABLE "plans";

-- DropTable
DROP TABLE "quickbooks_connection";

-- DropTable
DROP TABLE "quickbooks_sync_log";

-- DropTable
DROP TABLE "subscriptions";

-- DropTable
DROP TABLE "team_usage";

-- DropTable
DROP TABLE "usage_records";

-- DropEnum
DROP TYPE "InvoiceLineItemType";

-- DropEnum
DROP TYPE "MigrationArchiveStatus";

-- DropEnum
DROP TYPE "MigrationFileUploadStatus";

-- DropEnum
DROP TYPE "MigrationJobStatus";

-- DropEnum
DROP TYPE "MigrationRestoreMode";

-- DropEnum
DROP TYPE "MigrationRetention";

-- DropEnum
DROP TYPE "MigrationRiskLevel";

-- DropEnum
DROP TYPE "MigrationSource";

-- DropEnum
DROP TYPE "SubscriptionStatus";
