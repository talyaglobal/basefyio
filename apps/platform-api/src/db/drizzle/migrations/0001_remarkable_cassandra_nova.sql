CREATE TYPE "public"."attachment_kind" AS ENUM('rag_citation', 'sql_result', 'http_response', 'file');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_run_attachments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"step" integer NOT NULL,
	"tool_call_id" text,
	"kind" "attachment_kind" NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_run_attachments" ADD CONSTRAINT "agent_run_attachments_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_run_attachments" ADD CONSTRAINT "agent_run_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_attachments_run_step_idx" ON "agent_run_attachments" USING btree ("run_id","step");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_attachments_project_idx" ON "agent_run_attachments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_attachments_tool_call_idx" ON "agent_run_attachments" USING btree ("tool_call_id");