-- Per-team role permission overrides.
-- OWNER always has full access (not stored here).
-- Each team can customise what ADMIN and MEMBER roles are allowed to do.

CREATE TABLE "team_role_permissions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "team_id" TEXT NOT NULL,
    "role" "TeamMemberRole" NOT NULL,
    "can_rename_team" BOOLEAN NOT NULL DEFAULT false,
    "can_invite_members" BOOLEAN NOT NULL DEFAULT false,
    "can_remove_members" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_integrations" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "team_role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_role_permissions_team_id_role_key" ON "team_role_permissions"("team_id", "role");

ALTER TABLE "team_role_permissions"
    ADD CONSTRAINT "team_role_permissions_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed default permissions for every existing team:
-- ADMIN gets all permissions by default, MEMBER gets none.
INSERT INTO "team_role_permissions" ("team_id", "role", "can_rename_team", "can_invite_members", "can_remove_members", "can_manage_integrations")
SELECT id, 'ADMIN', true, true, true, true FROM "teams";

INSERT INTO "team_role_permissions" ("team_id", "role", "can_rename_team", "can_invite_members", "can_remove_members", "can_manage_integrations")
SELECT id, 'MEMBER', false, false, false, false FROM "teams";
