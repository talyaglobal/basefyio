-- CreateTable
CREATE TABLE "pitr_restore_jobs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "requested_by" TEXT,
    "target_time" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "phase" VARCHAR(32) NOT NULL DEFAULT 'waiting',
    "message" TEXT,
    "error" TEXT,
    "method" VARCHAR(16),
    "exact" BOOLEAN,
    "restored_to" TIMESTAMP(3),
    "run_id" VARCHAR(32),
    "worker_id" VARCHAR(128),
    "heartbeat_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pitr_restore_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pitr_restore_jobs_project_id_created_at_idx" ON "pitr_restore_jobs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pitr_restore_jobs_status_created_at_idx" ON "pitr_restore_jobs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "pitr_restore_jobs" ADD CONSTRAINT "pitr_restore_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

