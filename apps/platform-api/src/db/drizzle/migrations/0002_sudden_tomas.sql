CREATE TYPE "public"."provisioning_actor_type" AS ENUM('user', 'system', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."provisioning_operation_status" AS ENUM('pending', 'planning', 'approved', 'applying', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."provisioning_operation_type" AS ENUM('plan', 'create', 'update', 'destroy', 'rollback');--> statement-breakpoint
CREATE TYPE "public"."provisioning_provider" AS ENUM('hetzner', 'aws', 'gcp', 'azure');--> statement-breakpoint
CREATE TYPE "public"."provisioning_resource_state" AS ENUM('present', 'absent');--> statement-breakpoint
CREATE TYPE "public"."provisioning_resource_status" AS ENUM('unknown', 'creating', 'running', 'updating', 'deleting', 'deleted', 'error');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provisioning_audit_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"operation_id" text,
	"resource_id" text,
	"actor_id" text,
	"actor_type" "provisioning_actor_type" DEFAULT 'system' NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"metadata" jsonb,
	"ip_address" varchar(45),
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provisioning_credential_refs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"provider" "provisioning_provider" NOT NULL,
	"vault_mount" varchar(256) NOT NULL,
	"vault_path" varchar(512) NOT NULL,
	"description" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provisioning_operations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"provisioning_project_id" text NOT NULL,
	"resource_id" text,
	"operation_type" "provisioning_operation_type" NOT NULL,
	"status" "provisioning_operation_status" DEFAULT 'pending' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"plan_output" jsonb,
	"cost_estimate" jsonb,
	"apply_output" jsonb,
	"error" text,
	"error_code" varchar(64),
	"approved_by" text,
	"approved_at" timestamp (3),
	"created_by" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"started_at" timestamp (3),
	"completed_at" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provisioning_projects" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"team_id" text NOT NULL,
	"provider" "provisioning_provider" NOT NULL,
	"region" varchar(64) NOT NULL,
	"datacenter" varchar(64) NOT NULL,
	"credential_ref_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provisioning_resources" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"provisioning_project_id" text NOT NULL,
	"provider" "provisioning_provider" NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_kind" varchar(128),
	"external_id" varchar(256),
	"state" "provisioning_resource_state" DEFAULT 'present' NOT NULL,
	"status" "provisioning_resource_status" DEFAULT 'unknown' NOT NULL,
	"region" varchar(64) NOT NULL,
	"datacenter" varchar(64) NOT NULL,
	"desired_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actual_config" jsonb,
	"tags" jsonb,
	"idempotency_key" varchar(256) NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_audit_events" ADD CONSTRAINT "provisioning_audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_audit_events" ADD CONSTRAINT "provisioning_audit_events_operation_id_provisioning_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."provisioning_operations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_audit_events" ADD CONSTRAINT "provisioning_audit_events_resource_id_provisioning_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."provisioning_resources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_credential_refs" ADD CONSTRAINT "provisioning_credential_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_provisioning_project_id_provisioning_projects_id_fk" FOREIGN KEY ("provisioning_project_id") REFERENCES "public"."provisioning_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_resource_id_provisioning_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."provisioning_resources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_projects" ADD CONSTRAINT "provisioning_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_projects" ADD CONSTRAINT "provisioning_projects_credential_ref_id_provisioning_credential_refs_id_fk" FOREIGN KEY ("credential_ref_id") REFERENCES "public"."provisioning_credential_refs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_resources" ADD CONSTRAINT "provisioning_resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provisioning_resources" ADD CONSTRAINT "provisioning_resources_provisioning_project_id_provisioning_projects_id_fk" FOREIGN KEY ("provisioning_project_id") REFERENCES "public"."provisioning_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_audit_project_created_idx" ON "provisioning_audit_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_audit_operation_idx" ON "provisioning_audit_events" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_audit_resource_idx" ON "provisioning_audit_events" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_audit_event_type_idx" ON "provisioning_audit_events" USING btree ("project_id","event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_cred_refs_project_provider_idx" ON "provisioning_credential_refs" USING btree ("project_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prov_operations_idempotency_uq" ON "provisioning_operations" USING btree ("provisioning_project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_operations_project_status_idx" ON "provisioning_operations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_operations_resource_idx" ON "provisioning_operations" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_operations_in_flight_idx" ON "provisioning_operations" USING btree ("provisioning_project_id","status") WHERE "provisioning_operations"."status" IN ('pending','planning','approved','applying');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prov_projects_project_provider_uq" ON "provisioning_projects" USING btree ("project_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_projects_team_idx" ON "provisioning_projects" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prov_resources_idempotency_uq" ON "provisioning_resources" USING btree ("provisioning_project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_resources_project_type_idx" ON "provisioning_resources" USING btree ("project_id","resource_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_resources_external_id_idx" ON "provisioning_resources" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prov_resources_status_idx" ON "provisioning_resources" USING btree ("provisioning_project_id","status");