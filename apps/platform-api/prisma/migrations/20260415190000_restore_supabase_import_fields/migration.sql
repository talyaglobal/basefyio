ALTER TABLE "projects" RENAME COLUMN "remote_import_log" TO "supabase_import_log";

UPDATE "projects" SET "import_source" = 'SUPABASE' WHERE "import_source" = 'REMOTE';

UPDATE "project_activity_logs" SET "kind" = 'supabase_import.completed' WHERE "kind" = 'remote_import.completed';
UPDATE "project_activity_logs" SET "kind" = 'supabase_import.failed' WHERE "kind" = 'remote_import.failed';
UPDATE "project_activity_logs" SET "kind" = 'supabase_import.cancelled' WHERE "kind" = 'remote_import.cancelled';
