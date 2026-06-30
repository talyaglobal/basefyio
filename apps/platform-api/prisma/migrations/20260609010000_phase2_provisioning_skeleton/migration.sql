-- Phase 2: Provisioning Schema Skeleton
-- No SDK/API calls. State machines only.
-- No provider credential bytes in DB — OpenBao refs only.
-- Drizzle tables (rag_documents, rag_chunks, rag_index_jobs,
--   chat_threads, chat_messages, agent_memory) untouched.

-- Enums
CREATE TYPE "ProvisioningProjectStatus" AS ENUM (
    'PENDING', 'PROVISIONING', 'ACTIVE', 'UPDATING',
    'DESTROYING', 'DESTROYED', 'FAILED',
    'ROLLBACK_IN_PROGRESS', 'ROLLED_BACK'
);

CREATE TYPE "ProvisioningResourceStatus" AS ENUM (
    'PENDING', 'CREATING', 'ACTIVE', 'UPDATING',
    'DESTROYING', 'DESTROYED', 'FAILED',
    'ROLLING_BACK', 'ROLLED_BACK'
);

CREATE TYPE "ProvisioningOperationStatus" AS ENUM (
    'PENDING', 'DRY_RUN', 'RUNNING', 'COMPLETED', 'FAILED', 'ROLLED_BACK'
);

CREATE TYPE "ProvisioningOperationType" AS ENUM (
    'CREATE', 'UPDATE', 'DELETE', 'ROLLBACK'
);

CREATE TYPE "ProvisioningResourceKind" AS ENUM (
    'SERVER', 'VOLUME', 'NETWORK', 'FIREWALL',
    'LOAD_BALANCER', 'FLOATING_IP', 'SSH_KEY'
);

CREATE TYPE "ProvisioningEventKind" AS ENUM (
    'STATUS_CHANGED', 'OPERATION_STARTED', 'OPERATION_COMPLETED',
    'OPERATION_FAILED', 'DRY_RUN_COMPLETED', 'ROLLBACK_INITIATED',
    'ROLLBACK_COMPLETED', 'CREDENTIAL_ROTATED',
    'RESOURCE_CREATED', 'RESOURCE_UPDATED', 'RESOURCE_DESTROYED'
);

-- ProvisioningCredentialRef (referenced by ProvisioningProject — create first)
CREATE TABLE "provisioning_credential_refs" (
    "id"            TEXT NOT NULL,
    "team_id"       TEXT NOT NULL,
    "provider"      VARCHAR(30) NOT NULL DEFAULT 'hetzner',
    "label"         VARCHAR(100) NOT NULL,
    "openbao_path"  TEXT NOT NULL,
    "revoked_at"    TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provisioning_credential_refs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "provisioning_credential_refs_team_id_provider_idx"
    ON "provisioning_credential_refs"("team_id", "provider");
ALTER TABLE "provisioning_credential_refs"
    ADD CONSTRAINT "provisioning_credential_refs_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ProvisioningProject
CREATE TABLE "provisioning_projects" (
    "id"                TEXT NOT NULL,
    "project_id"        TEXT NOT NULL,
    "status"            "ProvisioningProjectStatus" NOT NULL DEFAULT 'PENDING',
    "provider"          VARCHAR(30) NOT NULL DEFAULT 'hetzner',
    "region"            VARCHAR(30) NOT NULL,
    "datacenter"        VARCHAR(60),
    "credential_ref_id" TEXT NOT NULL,
    "desired_state"     JSONB,
    "actual_state"      JSONB,
    "last_synced_at"    TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provisioning_projects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "provisioning_projects_project_id_key"
    ON "provisioning_projects"("project_id");
CREATE INDEX "provisioning_projects_status_idx"
    ON "provisioning_projects"("status");
ALTER TABLE "provisioning_projects"
    ADD CONSTRAINT "provisioning_projects_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provisioning_projects"
    ADD CONSTRAINT "provisioning_projects_credential_ref_id_fkey"
    FOREIGN KEY ("credential_ref_id") REFERENCES "provisioning_credential_refs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ProvisioningResource
CREATE TABLE "provisioning_resources" (
    "id"                       TEXT NOT NULL,
    "provisioning_project_id"  TEXT NOT NULL,
    "kind"                     "ProvisioningResourceKind" NOT NULL,
    "name"                     VARCHAR(255) NOT NULL,
    "status"                   "ProvisioningResourceStatus" NOT NULL DEFAULT 'PENDING',
    "region"                   VARCHAR(30) NOT NULL,
    "datacenter"               VARCHAR(60),
    "external_id"              VARCHAR(128),
    "desired_spec"             JSONB NOT NULL,
    "actual_spec"              JSONB,
    "rollback_spec"            JSONB,
    "last_synced_at"           TIMESTAMP(3),
    "destroyed_at"             TIMESTAMP(3),
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provisioning_resources_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "provisioning_resources_provisioning_project_id_status_idx"
    ON "provisioning_resources"("provisioning_project_id", "status");
CREATE INDEX "provisioning_resources_provisioning_project_id_kind_idx"
    ON "provisioning_resources"("provisioning_project_id", "kind");
ALTER TABLE "provisioning_resources"
    ADD CONSTRAINT "provisioning_resources_provisioning_project_id_fkey"
    FOREIGN KEY ("provisioning_project_id") REFERENCES "provisioning_projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ProvisioningOperation
CREATE TABLE "provisioning_operations" (
    "id"                       TEXT NOT NULL,
    "provisioning_project_id"  TEXT NOT NULL,
    "resource_id"              TEXT,
    "type"                     "ProvisioningOperationType" NOT NULL,
    "status"                   "ProvisioningOperationStatus" NOT NULL DEFAULT 'PENDING',
    "dry_run"                  BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key"          VARCHAR(128) NOT NULL,
    "requested_by"             TEXT NOT NULL,
    "input"                    JSONB,
    "result"                   JSONB,
    "error_message"            TEXT,
    "started_at"               TIMESTAMP(3),
    "completed_at"             TIMESTAMP(3),
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provisioning_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "provisioning_operations_project_idempotency_key"
    ON "provisioning_operations"("provisioning_project_id", "idempotency_key");
CREATE INDEX "provisioning_operations_provisioning_project_id_status_idx"
    ON "provisioning_operations"("provisioning_project_id", "status");
CREATE INDEX "provisioning_operations_resource_id_created_at_idx"
    ON "provisioning_operations"("resource_id", "created_at" DESC);
ALTER TABLE "provisioning_operations"
    ADD CONSTRAINT "provisioning_operations_provisioning_project_id_fkey"
    FOREIGN KEY ("provisioning_project_id") REFERENCES "provisioning_projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provisioning_operations"
    ADD CONSTRAINT "provisioning_operations_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "provisioning_resources"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ProvisioningAuditEvent (immutable — never updated)
CREATE TABLE "provisioning_audit_events" (
    "id"                       TEXT NOT NULL,
    "provisioning_project_id"  TEXT NOT NULL,
    "resource_id"              TEXT,
    "operation_id"             TEXT,
    "kind"                     "ProvisioningEventKind" NOT NULL,
    "actor_user_id"            TEXT,
    "from_status"              VARCHAR(40),
    "to_status"                VARCHAR(40),
    "detail"                   JSONB,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provisioning_audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "provisioning_audit_events_project_created_at_idx"
    ON "provisioning_audit_events"("provisioning_project_id", "created_at" DESC);
CREATE INDEX "provisioning_audit_events_resource_id_created_at_idx"
    ON "provisioning_audit_events"("resource_id", "created_at" DESC);
ALTER TABLE "provisioning_audit_events"
    ADD CONSTRAINT "provisioning_audit_events_provisioning_project_id_fkey"
    FOREIGN KEY ("provisioning_project_id") REFERENCES "provisioning_projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provisioning_audit_events"
    ADD CONSTRAINT "provisioning_audit_events_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "provisioning_resources"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provisioning_audit_events"
    ADD CONSTRAINT "provisioning_audit_events_operation_id_fkey"
    FOREIGN KEY ("operation_id") REFERENCES "provisioning_operations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
