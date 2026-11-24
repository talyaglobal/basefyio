-- Extra database roles: NOLOGIN group roles beside the login roles.
-- Additive: a column with a default (every existing row is a login role) and a wider column.
ALTER TABLE "project_extra_roles" ADD COLUMN     "kind" VARCHAR(8) NOT NULL DEFAULT 'login',
ALTER COLUMN "member_of" SET DATA TYPE VARCHAR(512);
