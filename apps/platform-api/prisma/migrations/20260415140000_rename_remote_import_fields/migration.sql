-- Rename import log column to neutral naming
ALTER TABLE "projects" RENAME COLUMN "supabase_import_log" TO "remote_import_log";

-- Normalize import source label
UPDATE "projects" SET "import_source" = 'REMOTE' WHERE "import_source" = 'SUPABASE';

-- Activity log kind strings (no legacy keys required in application code)
UPDATE "project_activity_logs" SET "kind" = 'remote_import.completed' WHERE "kind" = 'supabase_import.completed';
UPDATE "project_activity_logs" SET "kind" = 'remote_import.failed' WHERE "kind" = 'supabase_import.failed';
UPDATE "project_activity_logs" SET "kind" = 'remote_import.cancelled' WHERE "kind" = 'supabase_import.cancelled';
