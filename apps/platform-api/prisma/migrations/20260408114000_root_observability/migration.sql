-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "severity" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "before_json" JSONB,
    "after_json" JSONB,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "root_alerts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "related_audit_log_id" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "root_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_trace_id_idx" ON "audit_logs"("trace_id");

-- CreateIndex
CREATE INDEX "root_alerts_is_read_created_at_idx" ON "root_alerts"("is_read", "created_at" DESC);

-- CreateIndex
CREATE INDEX "root_alerts_kind_created_at_idx" ON "root_alerts"("kind", "created_at" DESC);

