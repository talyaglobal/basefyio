-- Row-Level Security bootstrap marker.
--
-- The actual RLS roles (anon / authenticated / service_role) and the auth.*
-- helper functions live inside *each project's* database, not this one —
-- see apps/platform-api/src/modules/projects/sql/rls-bootstrap.sql and
-- ProjectsService.applyRlsBootstrap().
--
-- This column lets the control plane know which project DBs have been
-- bootstrapped so the backfill script can be re-run safely and so the UI
-- can show RLS status.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "rls_bootstrapped_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "projects_rls_bootstrapped_at_idx"
  ON "projects"("rls_bootstrapped_at");
