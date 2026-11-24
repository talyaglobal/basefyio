-- CreateTable
CREATE TABLE "project_deletion_records" (
    "id" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "project_id" TEXT NOT NULL,
    "project_name" TEXT NOT NULL,
    "project_slug" TEXT,
    "parent_project_id" TEXT,
    "team_id" TEXT,
    "team_name" TEXT,
    "actor_user_id" TEXT,
    "reason_code" VARCHAR(80),
    "reason_label" VARCHAR(512),
    "details" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_deletion_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_deletion_records_created_at_idx" ON "project_deletion_records"("created_at" DESC);

-- CreateIndex
CREATE INDEX "project_deletion_records_project_id_created_at_idx" ON "project_deletion_records"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "project_deletion_records_kind_created_at_idx" ON "project_deletion_records"("kind", "created_at" DESC);

