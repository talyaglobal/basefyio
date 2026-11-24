-- Extra database roles: several memberships and per-role run-time limits.
-- Additive: widens a column and adds a nullable one; existing rows keep their values.
ALTER TABLE "project_extra_roles" ADD COLUMN     "settings" JSONB,
ALTER COLUMN "member_of" SET DATA TYPE VARCHAR(64);
