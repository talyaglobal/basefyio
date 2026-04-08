-- Role permission matrix configurable by ROOT users.
CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "can_access_management" BOOLEAN NOT NULL DEFAULT false,
  "can_manage_users" BOOLEAN NOT NULL DEFAULT false,
  "can_manage_teams" BOOLEAN NOT NULL DEFAULT false,
  "can_manage_plans" BOOLEAN NOT NULL DEFAULT false,
  "can_manage_user_packages" BOOLEAN NOT NULL DEFAULT false,
  "can_moderate_feedback" BOOLEAN NOT NULL DEFAULT false,
  "can_view_audit_logs" BOOLEAN NOT NULL DEFAULT false,
  "can_view_root_alerts" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_role_key" ON "role_permissions"("role");

INSERT INTO "role_permissions" (
  "id",
  "role",
  "can_access_management",
  "can_manage_users",
  "can_manage_teams",
  "can_manage_plans",
  "can_manage_user_packages",
  "can_moderate_feedback",
  "can_view_audit_logs",
  "can_view_root_alerts"
)
VALUES
  (gen_random_uuid()::text, 'USER', false, false, false, false, false, false, false, false),
  (gen_random_uuid()::text, 'ADMIN', true, true, true, true, true, true, false, false),
  (gen_random_uuid()::text, 'ROOT', true, true, true, true, true, true, true, true)
ON CONFLICT ("role") DO NOTHING;
