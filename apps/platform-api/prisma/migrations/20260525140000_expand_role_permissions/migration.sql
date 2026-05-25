-- Expand role permissions with project and billing flags.

ALTER TABLE "team_role_permissions"
  ADD COLUMN "can_create_projects" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "can_delete_projects" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "can_restore_projects" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "can_move_projects" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "can_view_billing" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "can_manage_billing" BOOLEAN NOT NULL DEFAULT false;

-- ADMIN rows get all new permissions enabled by default.
UPDATE "team_role_permissions"
SET "can_create_projects" = true,
    "can_delete_projects" = true,
    "can_restore_projects" = true,
    "can_move_projects" = true,
    "can_view_billing" = true,
    "can_manage_billing" = false
WHERE "role" = 'ADMIN';

-- MEMBER rows: only project creation enabled by default.
UPDATE "team_role_permissions"
SET "can_create_projects" = true,
    "can_view_billing" = false
WHERE "role" = 'MEMBER';
