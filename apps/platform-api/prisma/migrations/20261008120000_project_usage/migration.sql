-- Per-project resource snapshot behind the Billing cost breakdown.
-- Additive only: quotas keep reading team_usage.
CREATE TABLE "project_usage" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "db_size_bytes" BIGINT NOT NULL DEFAULT 0,
    "storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "api_requests_month" INTEGER NOT NULL DEFAULT 0,
    "bandwidth_month" BIGINT NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storage_calculated_at" TIMESTAMP(3),
    "last_calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_usage_project_id_key" ON "project_usage"("project_id");
CREATE INDEX "project_usage_team_id_idx" ON "project_usage"("team_id");

ALTER TABLE "project_usage" ADD CONSTRAINT "project_usage_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
