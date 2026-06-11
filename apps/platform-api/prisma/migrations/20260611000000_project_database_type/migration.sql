-- New Project wizard: persist the developer's database model choice.
-- RELATIONAL = tables in the project's PostgreSQL DB (current behavior, default
-- for all existing rows). NOSQL = Data Engine document collections.
CREATE TYPE "ProjectDatabaseType" AS ENUM ('RELATIONAL', 'NOSQL');

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "database_type" "ProjectDatabaseType" NOT NULL DEFAULT 'RELATIONAL';
