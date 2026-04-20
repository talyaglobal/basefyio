-- Kolaybase RLS bootstrap (Supabase-compatible surface).
-- Runs on each project database. Idempotent — safe to re-run.
--
-- Creates:
--   * Roles:  anon, authenticated, service_role
--   * Schema: auth
--   * Funcs:  auth.jwt(), auth.uid(), auth.role(), auth.email()
--   * Default privileges so future tables owned by the project owner
--     are visible to authenticated/service_role (RLS still applies).
--
-- The project owner (kb_user_<slug>) remains the table owner, but
-- PublicApiService sets LOCAL ROLE to anon / authenticated / service_role
-- before each statement so RLS policies are enforced.

-- ─────────────────────────────────────────────────────────────
-- 1. Roles
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END$$;

-- The project's login role needs to be able to SET ROLE to each of these.
-- %KB_PROJECT_OWNER% is replaced by projects.service.ts with the sanitized
-- dbUser (e.g. kb_user_myproj).
GRANT anon, authenticated, service_role TO "%KB_PROJECT_OWNER%";

-- ─────────────────────────────────────────────────────────────
-- 2. Schema + grants
-- ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION "%KB_PROJECT_OWNER%";

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth   TO anon, authenticated, service_role;

-- Default privileges for objects created by the project owner going forward.
-- (Existing tables will also be backfilled below.)
ALTER DEFAULT PRIVILEGES FOR ROLE "%KB_PROJECT_OWNER%" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE "%KB_PROJECT_OWNER%" IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE "%KB_PROJECT_OWNER%" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE "%KB_PROJECT_OWNER%" IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Apply to tables that already exist in this project.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- 3. auth helpers
--
-- These read the JWT claims that PublicApiService injects with
--   SELECT set_config('request.jwt.claims', '<json>', true);
-- inside each transaction.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT (auth.jwt() ->> 'sub');
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.role', true), ''),
    auth.jwt() ->> 'role',
    'anon'
  );
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT (auth.jwt() ->> 'email');
$$;

GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;
