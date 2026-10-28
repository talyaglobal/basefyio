-- basefyio RLS bootstrap (Supabase-compatible surface).
-- Runs on each project database. Idempotent — safe to re-run.
--
-- Creates:
--   * Roles:  anon, authenticated, service_role
--   * Schema: auth
--   * Funcs:  auth.jwt(), auth.uid(), auth.role(), auth.email()
--   * Default privileges so future tables owned by the project owner
--     are visible to authenticated/service_role (RLS still applies).
--
-- The project owner (kb_user_<random>) remains the table owner, but
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
-- %BF_PROJECT_OWNER% is replaced by projects.service.ts with the sanitized
-- dbUser (e.g. kb_user_myproj).
GRANT anon, authenticated, service_role TO "%BF_PROJECT_OWNER%";

-- ─────────────────────────────────────────────────────────────
-- 2. Schema + grants
-- ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION "%BF_PROJECT_OWNER%";

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth   TO anon, authenticated, service_role;

-- Default privileges for objects created by the project owner going forward.
-- (Existing tables will also be backfilled below.)
ALTER DEFAULT PRIVILEGES FOR ROLE "%BF_PROJECT_OWNER%" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE "%BF_PROJECT_OWNER%" IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE "%BF_PROJECT_OWNER%" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE "%BF_PROJECT_OWNER%" IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Apply to tables that already exist in this project.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- 3. auth helpers — create only if absent.
--
-- IMPORTANT: we deliberately do NOT use CREATE OR REPLACE here.
-- Supabase-imported projects already have auth.uid() RETURNING uuid
-- (Supabase's signature) along with RLS policies that depend on that
-- exact return type. If we tried to redefine auth.uid() RETURNS text,
-- Postgres rejects with "cannot change return type of existing
-- function" and the bootstrap aborts. Skipping when present keeps
-- existing policies intact and treats basefyio's helpers as a safe
-- default for fresh projects only.
--
-- These read the JWT claims that PublicApiService injects with
--   SELECT set_config('request.jwt.claims', '<json>', true);
-- inside each transaction.
-- ─────────────────────────────────────────────────────────────
-- Helper to test whether an auth.<name> function already exists at all
-- (any signature). We match on name only so that a Supabase-style uuid
-- auth.uid() is preserved — its existence proves the project's policies
-- depend on that exact signature.
DO $auth_jwt$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'jwt'
  ) THEN
    CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $body$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
        '{}'::jsonb
      );
    $body$;
  END IF;
END$auth_jwt$;

DO $auth_uid$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE FUNCTION auth.uid() RETURNS text
    LANGUAGE sql STABLE
    AS $body$
      SELECT (auth.jwt() ->> 'sub');
    $body$;
  END IF;
END$auth_uid$;

DO $auth_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'role'
  ) THEN
    CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $body$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.role', true), ''),
        auth.jwt() ->> 'role',
        'anon'
      );
    $body$;
  END IF;
END$auth_role$;

DO $auth_email$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'email'
  ) THEN
    CREATE FUNCTION auth.email() RETURNS text
    LANGUAGE sql STABLE
    AS $body$
      SELECT (auth.jwt() ->> 'email');
    $body$;
  END IF;
END$auth_email$;

-- Schema-wide grant: covers any signature (ours OR Supabase's), so we
-- don't need to enumerate (jwt(), uid(), role(), email()) — which would
-- itself fail on signature mismatch.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth
  TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- ─────────────────────────────────────────────────────────────
-- 4. Sentinel — verify the project owner can actually SET ROLE
--    to each of anon/authenticated/service_role. If any switch
--    fails, the entire bootstrap aborts instead of being marked
--    "applied" silently. Without this, GRANT failures (e.g. caused
--    by a stale role definition or pre-existing membership conflict)
--    leave the data API permanently 500-ing on
--    "permission denied to set role <X>".
-- ─────────────────────────────────────────────────────────────
DO $sentinel$
DECLARE
  target text;
  failed text[] := ARRAY[]::text[];
BEGIN
  -- Run inside a sub-block so we always RESET ROLE before exiting.
  BEGIN
    SET LOCAL ROLE "%BF_PROJECT_OWNER%";
    FOREACH target IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', target);
        EXECUTE format('SET LOCAL ROLE %I', '%BF_PROJECT_OWNER%');
      EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
        failed := failed || target;
      END;
    END LOOP;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE;
  END;

  IF array_length(failed, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'rls-bootstrap sentinel failed: project owner "%" cannot SET ROLE to: %. '
      'Check that the roles exist (pg_roles) and that GRANT membership succeeded.',
      '%BF_PROJECT_OWNER%', array_to_string(failed, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END$sentinel$;


-- ─────────────────────────────────────────────────────────────
-- 5. Storage catalog — the `storage` schema the Supabase-compatible
--    storage facade evaluates its RLS policies against.
--
--    storage.buckets / storage.objects mirror the object store (MinIO or
--    S3): the platform writes a row for every bucket and object it stores,
--    as the project owner, and the facade asks "may this caller insert /
--    select / delete this row?" under anon / authenticated / service_role
--    before it touches the store. Projects whose `storageAuthz` is
--    'presets' keep the catalog in sync too (so the switch to 'rls' is a
--    flag flip plus a backfill), but their access rules stay the
--    StoragePolicy presets.
--
--    Idempotent. The helper functions are guarded with DO blocks, never
--    CREATE OR REPLACE: a project imported from Supabase may already carry
--    them (with policies depending on their exact signature), and must keep
--    them. Types match Supabase's: `owner` uuid, `owner_id` text — fresh
--    projects, whose auth.uid() returns text, write policies as
--    `owner_id = auth.uid()`; imported projects keep `owner = auth.uid()`.
-- ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION "%BF_PROJECT_OWNER%";

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  owner              uuid,
  owner_id           text,
  public             boolean NOT NULL DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        text REFERENCES storage.buckets(id),
  name             text NOT NULL,
  owner            uuid,
  owner_id         text,
  metadata         jsonb,
  user_metadata    jsonb,
  version          text,
  path_tokens      text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  CONSTRAINT objects_bucket_name_key UNIQUE (bucket_id, name)
);

CREATE INDEX IF NOT EXISTS objects_bucket_name_pattern
  ON storage.objects (bucket_id, name text_pattern_ops);

ALTER TABLE storage.buckets OWNER TO "%BF_PROJECT_OWNER%";
ALTER TABLE storage.objects OWNER TO "%BF_PROJECT_OWNER%";

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE "%BF_PROJECT_OWNER%" IN SCHEMA storage
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- Path helpers the Supabase policy idiom relies on:
--   storage.foldername(name)  every segment but the last, as an array
--   storage.filename(name)    the last segment
--   storage.extension(name)   what follows the last '.' of the last segment
DO $storage_foldername$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'storage' AND p.proname = 'foldername'
  ) THEN
    CREATE FUNCTION storage.foldername(name text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $body$
      SELECT CASE
        WHEN array_length(string_to_array(name, '/'), 1) > 1
          THEN (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
        ELSE ARRAY[]::text[]
      END;
    $body$;
    ALTER FUNCTION storage.foldername(text) OWNER TO "%BF_PROJECT_OWNER%";
  END IF;
END$storage_foldername$;

DO $storage_filename$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'storage' AND p.proname = 'filename'
  ) THEN
    CREATE FUNCTION storage.filename(name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $body$
      SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)];
    $body$;
    ALTER FUNCTION storage.filename(text) OWNER TO "%BF_PROJECT_OWNER%";
  END IF;
END$storage_filename$;

DO $storage_extension$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'storage' AND p.proname = 'extension'
  ) THEN
    CREATE FUNCTION storage.extension(name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $body$
      SELECT CASE
        WHEN position('.' in storage.filename(name)) > 0
          THEN reverse(split_part(reverse(storage.filename(name)), '.', 1))
        ELSE ''
      END;
    $body$;
    ALTER FUNCTION storage.extension(text) OWNER TO "%BF_PROJECT_OWNER%";
  END IF;
END$storage_extension$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA storage TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
