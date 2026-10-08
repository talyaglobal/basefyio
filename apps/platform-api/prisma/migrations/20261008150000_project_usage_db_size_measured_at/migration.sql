-- Track when each project database was last measured, apart from last_calculated_at
-- (which the storage pass and counter flushes also bump).
ALTER TABLE "project_usage" ADD COLUMN "db_size_calculated_at" TIMESTAMP(3);
