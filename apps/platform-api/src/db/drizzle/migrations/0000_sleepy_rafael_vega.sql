CREATE TYPE "public"."rag_document_status" AS ENUM('PENDING', 'PROCESSING', 'INDEXED', 'FAILED', 'STALE');--> statement-breakpoint
CREATE TYPE "public"."rag_granularity" AS ENUM('word', 'sentence', 'context');--> statement-breakpoint
CREATE TYPE "public"."rag_index_job_kind" AS ENUM('INDEX', 'REINDEX', 'REINDEX_INCOMPLETE');--> statement-breakpoint
CREATE TYPE "public"."rag_index_job_status" AS ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."agent_memory_kind" AS ENUM('short_term', 'long_term', 'summary');--> statement-breakpoint
CREATE TYPE "public"."agent_policy_decision" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."agent_tool_call_status" AS ENUM('allowed', 'denied', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('system', 'user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."agent_provider" AS ENUM('openai', 'nebius-private', 'ollama');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."agent_tool_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rag_chunks" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" text NOT NULL,
	"project_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"overlap_chars" integer DEFAULT 0 NOT NULL,
	"token_count" integer,
	"prev_chunk_id" text,
	"embedding_record_id" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rag_documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"bucket_name" varchar(63) NOT NULL,
	"object_key" text NOT NULL,
	"title" varchar(512),
	"content_type" varchar(128),
	"size_bytes" bigint,
	"source_hash" varchar(64),
	"status" "rag_document_status" DEFAULT 'PENDING' NOT NULL,
	"granularity" "rag_granularity" DEFAULT 'sentence' NOT NULL,
	"chunk_size" integer DEFAULT 1000 NOT NULL,
	"chunk_overlap" integer DEFAULT 200 NOT NULL,
	"chunker_version" varchar(16) DEFAULT 'v1' NOT NULL,
	"normalized_format" varchar(32),
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"metadata" jsonb,
	"indexed_at" timestamp (3),
	"created_by" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rag_index_jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"document_id" text,
	"kind" "rag_index_job_kind" DEFAULT 'INDEX' NOT NULL,
	"status" "rag_index_job_status" DEFAULT 'QUEUED' NOT NULL,
	"dedupe_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"total_docs" integer DEFAULT 0 NOT NULL,
	"processed_docs" integer DEFAULT 0 NOT NULL,
	"total_chunks" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp (3),
	"finished_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_memory" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text,
	"thread_id" text,
	"kind" "agent_memory_kind" DEFAULT 'long_term' NOT NULL,
	"content" text NOT NULL,
	"importance" integer DEFAULT 0 NOT NULL,
	"embedding_record_id" text,
	"metadata" jsonb,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"expires_at" timestamp (3),
	CONSTRAINT "agent_memory_importance_chk" CHECK ("agent_memory"."importance" >= 0 AND "agent_memory"."importance" <= 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_policy_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text,
	"tool_call_id" text,
	"project_id" text NOT NULL,
	"decision" "agent_policy_decision" NOT NULL,
	"reason_code" varchar(64),
	"matched_rule" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_tool_calls" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text,
	"thread_id" text,
	"project_id" text NOT NULL,
	"tool_id" varchar(128) NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"status" "agent_tool_call_status" NOT NULL,
	"latency_ms" integer,
	"denied_reason" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"project_id" text NOT NULL,
	"role" "chat_role" NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"metadata" jsonb,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_threads" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text,
	"title" varchar(512),
	"metadata" jsonb,
	"created_by" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version_id" text NOT NULL,
	"thread_id" text,
	"project_id" text NOT NULL,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error_code" varchar(64),
	"error" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"finished_at" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_tools" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" varchar(128) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb,
	"risk" "agent_tool_risk" DEFAULT 'low' NOT NULL,
	"mutating" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"system_prompt" text NOT NULL,
	"model" varchar(128) NOT NULL,
	"provider" "agent_provider" DEFAULT 'openai' NOT NULL,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"max_tokens" integer DEFAULT 4096 NOT NULL,
	"max_steps" integer DEFAULT 10 NOT NULL,
	"tools_config" jsonb DEFAULT '{"toolIds":[]}'::jsonb NOT NULL,
	"model_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"team_id" text NOT NULL,
	"name" varchar(256) NOT NULL,
	"slug" varchar(256) NOT NULL,
	"description" text,
	"status" "agent_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" text,
	"created_by" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_document_id_rag_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rag_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_prev_chunk_id_rag_chunks_id_fk" FOREIGN KEY ("prev_chunk_id") REFERENCES "public"."rag_chunks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_embedding_record_id_embedding_records_id_fk" FOREIGN KEY ("embedding_record_id") REFERENCES "public"."embedding_records"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_index_jobs" ADD CONSTRAINT "rag_index_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_index_jobs" ADD CONSTRAINT "rag_index_jobs_document_id_rag_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rag_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_embedding_record_id_embedding_records_id_fk" FOREIGN KEY ("embedding_record_id") REFERENCES "public"."embedding_records"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_policy_events" ADD CONSTRAINT "agent_policy_events_tool_call_id_agent_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."agent_tool_calls"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_policy_events" ADD CONSTRAINT "agent_policy_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rag_chunks_doc_index_uq" ON "rag_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_chunks_project_idx" ON "rag_chunks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_chunks_document_idx" ON "rag_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_chunks_embedding_idx" ON "rag_chunks" USING btree ("embedding_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rag_documents_object_uq" ON "rag_documents" USING btree ("project_id","bucket_name","object_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_documents_project_status_idx" ON "rag_documents" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rag_index_jobs_dedupe_uq" ON "rag_index_jobs" USING btree ("project_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_index_jobs_project_status_idx" ON "rag_index_jobs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_project_kind_idx" ON "agent_memory" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_agent_idx" ON "agent_memory" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_embedding_idx" ON "agent_memory" USING btree ("embedding_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_expires_idx" ON "agent_memory" USING btree ("project_id","expires_at") WHERE "agent_memory"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_policy_events_project_idx" ON "agent_policy_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_policy_events_tool_call_idx" ON "agent_policy_events" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_policy_events_run_idx" ON "agent_policy_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_calls_project_idx" ON "agent_tool_calls" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_calls_thread_idx" ON "agent_tool_calls" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_calls_run_idx" ON "agent_tool_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_project_idx" ON "chat_messages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_project_idx" ON "chat_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_agent_idx" ON "chat_threads" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_project_idx" ON "agent_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_agent_status_idx" ON "agent_runs" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_thread_idx" ON "agent_runs" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tools_tool_id_uq" ON "agent_tools" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tools_enabled_idx" ON "agent_tools" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_versions_agent_version_uq" ON "agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_versions_agent_idx" ON "agent_versions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_project_slug_uq" ON "agents" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_project_status_idx" ON "agents" USING btree ("project_id","status");