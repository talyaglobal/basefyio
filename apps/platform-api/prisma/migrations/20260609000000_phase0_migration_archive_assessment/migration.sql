-- Phase 0: Migration Archive + Assessment
-- Prisma control-plane only. Drizzle tables (rag_documents, rag_chunks,
-- rag_index_jobs, chat_threads, chat_messages, agent_memory) are NOT touched.

-- Enums
CREATE TYPE "MigrationArchiveStatus" AS ENUM ('CREATING', 'ACTIVE', 'DELETING', 'DELETED');
CREATE TYPE "MigrationFileUploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'COMPLETE', 'FAILED');
CREATE TYPE "MigrationSource" AS ENUM ('USER_UPLOAD', 'WE_IMPORT');
CREATE TYPE "MigrationRetention" AS ENUM ('TEMPORARY_30D', 'STANDARD_1Y', 'LONG_TERM');
CREATE TYPE "MigrationRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "MigrationRestoreMode" AS ENUM ('SAME_PROJECT', 'NEW_PROJECT', 'EXPORT_BUNDLE');
CREATE TYPE "MigrationJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "InvoiceLineItemType" AS ENUM ('PLAN', 'AI_TOKENS', 'MIGRATION_ARCHIVE_STORAGE');

-- MigrationArchive
CREATE TABLE "migration_archives" (
    "id"                   TEXT NOT NULL,
    "project_id"           TEXT NOT NULL,
    "bucket_name"          TEXT NOT NULL,
    "status"               "MigrationArchiveStatus" NOT NULL DEFAULT 'CREATING',
    "source"               "MigrationSource" NOT NULL,
    "retention"            "MigrationRetention" NOT NULL DEFAULT 'STANDARD_1Y',
    "region"               VARCHAR(10) NOT NULL,
    "encrypted_at_rest"    BOOLEAN NOT NULL DEFAULT true,
    "consent_completed_at" TIMESTAMP(3),
    "total_bytes"          BIGINT NOT NULL DEFAULT 0,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"           TIMESTAMP(3),
    CONSTRAINT "migration_archives_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "migration_archives_project_id_status_idx"
    ON "migration_archives"("project_id", "status");
ALTER TABLE "migration_archives"
    ADD CONSTRAINT "migration_archives_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrationArchiveFile
CREATE TABLE "migration_archive_files" (
    "id"             TEXT NOT NULL,
    "archive_id"     TEXT NOT NULL,
    "filename"       TEXT NOT NULL,
    "object_key"     TEXT NOT NULL,
    "size_bytes"     BIGINT NOT NULL,
    "content_type"   VARCHAR(80),
    "upload_status"  "MigrationFileUploadStatus" NOT NULL DEFAULT 'PENDING',
    "uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
    "chunk_size"     INTEGER,
    "checksum"       VARCHAR(128),
    "resume_token"   VARCHAR(512),
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "migration_archive_files_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "migration_archive_files_archive_id_upload_status_idx"
    ON "migration_archive_files"("archive_id", "upload_status");
ALTER TABLE "migration_archive_files"
    ADD CONSTRAINT "migration_archive_files_archive_id_fkey"
    FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrationAssessment
CREATE TABLE "migration_assessments" (
    "id"                                   TEXT NOT NULL,
    "archive_id"                           TEXT NOT NULL,
    "project_id"                           TEXT NOT NULL,
    "tables_found"                         INTEGER NOT NULL,
    "records_found"                        BIGINT NOT NULL,
    "size_bytes"                           BIGINT NOT NULL,
    "relationships"                        INTEGER NOT NULL,
    "nested_json_structures"               INTEGER NOT NULL,
    "legacy_files"                         JSONB NOT NULL,
    "shape"                                VARCHAR(20) NOT NULL,
    "detected_entities"                    JSONB NOT NULL,
    "recommendation"                       JSONB NOT NULL,
    "complexity"                           VARCHAR(20) NOT NULL,
    "confidence_pct"                       DOUBLE PRECISION NOT NULL,
    "fully_automatable"                    BOOLEAN NOT NULL,
    "human_involvement_pct"                DOUBLE PRECISION NOT NULL,
    "estimated_people_hours"               DOUBLE PRECISION NOT NULL,
    "estimated_manual_review_hours"        DOUBLE PRECISION NOT NULL,
    "estimated_engineering_hours"          DOUBLE PRECISION NOT NULL,
    "estimated_duration_days"              DOUBLE PRECISION NOT NULL,
    "hourly_rate_cents"                    INTEGER NOT NULL,
    "estimated_cost_cents"                 INTEGER NOT NULL,
    "data_loss_risk_pct"                   DOUBLE PRECISION NOT NULL,
    "risk_level"                           "MigrationRiskLevel" NOT NULL,
    "risk_drivers"                         JSONB NOT NULL,
    "mitigations"                          JSONB NOT NULL,
    "business_impact"                      TEXT NOT NULL,
    "final_recommendation"                 JSONB NOT NULL,
    "estimated_archive_size_bytes"         BIGINT NOT NULL,
    "estimated_monthly_archive_cost_cents" INTEGER NOT NULL,
    "app_preview"                          JSONB,
    "assessment_version"                   INTEGER NOT NULL DEFAULT 1,
    "model_version"                        VARCHAR(80) NOT NULL,
    "superseded_by_id"                     TEXT,
    "report_pdf_object_key"                TEXT,
    "created_at"                           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "migration_assessments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "migration_assessments_archive_id_assessment_version_idx"
    ON "migration_assessments"("archive_id", "assessment_version");
CREATE INDEX "migration_assessments_project_id_created_at_idx"
    ON "migration_assessments"("project_id", "created_at" DESC);
ALTER TABLE "migration_assessments"
    ADD CONSTRAINT "migration_assessments_archive_id_fkey"
    FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "migration_assessments"
    ADD CONSTRAINT "migration_assessments_superseded_by_id_fkey"
    FOREIGN KEY ("superseded_by_id") REFERENCES "migration_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- MigrationRestoreJob
CREATE TABLE "migration_restore_jobs" (
    "id"                TEXT NOT NULL,
    "archive_id"        TEXT NOT NULL,
    "source_project_id" TEXT NOT NULL,
    "target_project_id" TEXT,
    "mode"              "MigrationRestoreMode" NOT NULL,
    "status"            "MigrationJobStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by"      TEXT NOT NULL,
    "started_at"        TIMESTAMP(3),
    "completed_at"      TIMESTAMP(3),
    "result_object_key" TEXT,
    "error"             TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "migration_restore_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "migration_restore_jobs_archive_id_status_idx"
    ON "migration_restore_jobs"("archive_id", "status");
CREATE INDEX "migration_restore_jobs_source_project_id_created_at_idx"
    ON "migration_restore_jobs"("source_project_id", "created_at" DESC);
ALTER TABLE "migration_restore_jobs"
    ADD CONSTRAINT "migration_restore_jobs_archive_id_fkey"
    FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrationImportCredential
CREATE TABLE "migration_import_credentials" (
    "id"                   TEXT NOT NULL,
    "archive_id"           TEXT NOT NULL,
    "project_id"           TEXT NOT NULL,
    "openbao_path"         TEXT NOT NULL,
    "engine_kind"          VARCHAR(30) NOT NULL,
    "metadata_scanned_at"  TIMESTAMP(3),
    "data_read_consent_at" TIMESTAMP(3),
    "revoked_at"           TIMESTAMP(3),
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "migration_import_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "migration_import_credentials_archive_id_key"
    ON "migration_import_credentials"("archive_id");
ALTER TABLE "migration_import_credentials"
    ADD CONSTRAINT "migration_import_credentials_archive_id_fkey"
    FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrationConsent (immutable rows — re-consent creates a new row, never updates)
CREATE TABLE "migration_consents" (
    "id"                        TEXT NOT NULL,
    "archive_id"                TEXT NOT NULL,
    "project_id"                TEXT NOT NULL,
    "user_id"                   TEXT NOT NULL,
    "team_id"                   TEXT NOT NULL,
    "accepted_at"               TIMESTAMP(3) NOT NULL,
    "ip_address"                VARCHAR(45) NOT NULL,
    "privacy_statement_version" VARCHAR(20) NOT NULL,
    "risk_statement_version"    VARCHAR(20) NOT NULL,
    "archive_policy_version"    VARCHAR(20) NOT NULL,
    "accepted_items"            JSONB NOT NULL,
    "sensitive_data_flags"      JSONB NOT NULL,
    "db_access_authorized"      BOOLEAN NOT NULL DEFAULT false,
    "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "migration_consents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "migration_consents_archive_id_created_at_idx"
    ON "migration_consents"("archive_id", "created_at");
ALTER TABLE "migration_consents"
    ADD CONSTRAINT "migration_consents_archive_id_fkey"
    FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrationArchiveLedger (projection — platform Invoice is authoritative for billing)
CREATE TABLE "migration_archive_ledgers" (
    "id"                TEXT NOT NULL,
    "archive_id"        TEXT NOT NULL,
    "stored_bytes"      BIGINT NOT NULL DEFAULT 0,
    "growth_bytes"      BIGINT NOT NULL DEFAULT 0,
    "accumulated_cents" INTEGER NOT NULL DEFAULT 0,
    "last_updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "migration_archive_ledgers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "migration_archive_ledgers_archive_id_key"
    ON "migration_archive_ledgers"("archive_id");
ALTER TABLE "migration_archive_ledgers"
    ADD CONSTRAINT "migration_archive_ledgers_archive_id_fkey"
    FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- InvoiceLineItem
CREATE TABLE "invoice_line_items" (
    "id"               TEXT NOT NULL,
    "invoice_id"       TEXT NOT NULL,
    "type"             "InvoiceLineItemType" NOT NULL,
    "description"      TEXT NOT NULL,
    "quantity"         INTEGER NOT NULL DEFAULT 1,
    "unit_price_cents" INTEGER NOT NULL,
    "amount_cents"     INTEGER NOT NULL,
    "archive_id"       TEXT,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items"("invoice_id");
CREATE INDEX "invoice_line_items_archive_id_idx" ON "invoice_line_items"("archive_id");
ALTER TABLE "invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_archive_id_fkey"
    FOREIGN KEY ("archive_id") REFERENCES "migration_archives"("id") ON DELETE SET NULL ON UPDATE CASCADE;
