CREATE TYPE "public"."agent_data_source_access" AS ENUM('read', 'write');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_version_data_sources" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_version_id" text NOT NULL,
	"data_structure_id" text NOT NULL,
	"access" "agent_data_source_access" DEFAULT 'read' NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_version_data_sources" ADD CONSTRAINT "agent_version_data_sources_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "avds_version_ds_uq" ON "agent_version_data_sources" USING btree ("agent_version_id","data_structure_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "avds_version_idx" ON "agent_version_data_sources" USING btree ("agent_version_id");
