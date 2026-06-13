-- Phase 5A: PKI / Certificate service
-- ProjectClientCertificate stores only OpenBao path references — no private key bytes.

CREATE TYPE "public"."certificate_status" AS ENUM ('ACTIVE', 'REVOKED', 'ARCHIVED', 'EXPIRED');
CREATE TYPE "public"."certificate_access_level" AS ENUM ('READ', 'READ_WRITE');

CREATE TABLE "project_client_certificates" (
    "id"              TEXT NOT NULL DEFAULT gen_random_uuid(),
    "project_id"      TEXT NOT NULL,
    "entitlement_ref" VARCHAR(128),
    "subject"         TEXT NOT NULL,
    "serial_number"   VARCHAR(256) NOT NULL,
    "fingerprint"     VARCHAR(128) NOT NULL,
    -- OpenBao KV path only — no private key bytes ever stored here
    "openbao_key_path"  TEXT NOT NULL,
    -- Public cert PEM and CA PEM are safe to store; private key is never here
    "certificate_pem"   TEXT,
    "ca_cert_pem"       TEXT,
    "access_level"    "certificate_access_level" NOT NULL DEFAULT 'READ_WRITE',
    "status"          "certificate_status" NOT NULL DEFAULT 'ACTIVE',
    "not_before"      TIMESTAMP(3) NOT NULL,
    "not_after"       TIMESTAMP(3) NOT NULL,
    "issued_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at"      TIMESTAMP(3),
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_client_certificates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_client_certificates_serial_number_key"
    ON "project_client_certificates"("serial_number");

CREATE INDEX "project_client_certificates_project_status_idx"
    ON "project_client_certificates"("project_id", "status");

ALTER TABLE "project_client_certificates"
    ADD CONSTRAINT "project_client_certificates_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Immutable audit log for every cert lifecycle action
CREATE TABLE "certificate_events" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid(),
    "project_id"     TEXT NOT NULL,
    "actor_user_id"  TEXT,
    "action"         VARCHAR(32) NOT NULL,
    "serial_number"  VARCHAR(256),
    "certificate_id" TEXT,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "certificate_events_project_created_idx"
    ON "certificate_events"("project_id", "created_at");

ALTER TABLE "certificate_events"
    ADD CONSTRAINT "certificate_events_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "certificate_events"
    ADD CONSTRAINT "certificate_events_certificate_id_fkey"
    FOREIGN KEY ("certificate_id") REFERENCES "project_client_certificates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
