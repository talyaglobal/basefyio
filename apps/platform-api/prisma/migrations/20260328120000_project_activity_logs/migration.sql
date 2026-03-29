-- CreateTable
CREATE TABLE "project_activity_logs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT,
    "kind" VARCHAR(80) NOT NULL,
    "title" VARCHAR(512) NOT NULL,
    "detail" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_activity_logs_project_id_created_at_idx" ON "project_activity_logs"("project_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "project_activity_logs" ADD CONSTRAINT "project_activity_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
