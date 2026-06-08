-- ============================================================================
-- Rebrand: Rename all kb_ prefixed databases and users to basefyio_
-- ============================================================================
--
-- IMPORTANT: Run this script connected to the "postgres" database (not the
-- application database), as a superuser. It must be run BEFORE the Prisma
-- migration so the actual DB objects match the updated metadata.
--
-- Usage:
--   psql -U postgres -d postgres -f scripts/rebrand-rename-dbs.sql
--
-- This script:
--   1. Renames the main platform database:  kolaybase → basefyio
--   2. Renames the main platform user:      kolaybase → basefyio
--   3. Renames all per-project databases:   kb_<slug> → basefyio_<slug>
--   4. Renames all per-project users:       kb_user_<hash> → basefyio_user_<hash>
--
-- Keycloak realm renames must be done via the Keycloak Admin API separately.
-- ============================================================================

-- Helper: terminate all connections to a database before renaming it
CREATE OR REPLACE FUNCTION pg_temp.terminate_and_rename_db(old_name text, new_name text)
RETURNS void AS $$
BEGIN
  -- Skip if old database doesn't exist
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = old_name) THEN
    RAISE NOTICE 'Database % does not exist, skipping', old_name;
    RETURN;
  END IF;
  -- Skip if new name already exists
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = new_name) THEN
    RAISE NOTICE 'Database % already exists, skipping rename from %', new_name, old_name;
    RETURN;
  END IF;
  -- Terminate active connections
  PERFORM pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = old_name AND pid != pg_backend_pid();
  -- Rename
  EXECUTE format('ALTER DATABASE %I RENAME TO %I', old_name, new_name);
  RAISE NOTICE 'Renamed database: % → %', old_name, new_name;
END;
$$ LANGUAGE plpgsql;

-- Helper: rename a PostgreSQL role
CREATE OR REPLACE FUNCTION pg_temp.rename_role(old_name text, new_name text)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = old_name) THEN
    RAISE NOTICE 'Role % does not exist, skipping', old_name;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = new_name) THEN
    RAISE NOTICE 'Role % already exists, skipping rename from %', new_name, old_name;
    RETURN;
  END IF;
  EXECUTE format('ALTER ROLE %I RENAME TO %I', old_name, new_name);
  RAISE NOTICE 'Renamed role: % → %', old_name, new_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Step 1: Rename the main platform database and user
-- ============================================================================

SELECT pg_temp.rename_role('kolaybase', 'basefyio');
SELECT pg_temp.terminate_and_rename_db('kolaybase', 'basefyio');

-- ============================================================================
-- Step 2: Rename all per-project databases (kb_<slug> → basefyio_<slug>)
-- ============================================================================

DO $$
DECLARE
  r RECORD;
  new_name text;
BEGIN
  FOR r IN
    SELECT datname FROM pg_database
    WHERE datname LIKE 'kb\_%'
    ORDER BY datname
  LOOP
    new_name := 'basefyio_' || substring(r.datname FROM 4);
    PERFORM pg_temp.terminate_and_rename_db(r.datname, new_name);
  END LOOP;
END;
$$;

-- ============================================================================
-- Step 3: Rename all per-project users (kb_user_<hash> → basefyio_user_<hash>)
-- ============================================================================

DO $$
DECLARE
  r RECORD;
  new_name text;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_roles
    WHERE rolname LIKE 'kb\_user\_%'
    ORDER BY rolname
  LOOP
    new_name := 'basefyio_user_' || substring(r.rolname FROM 9);
    PERFORM pg_temp.rename_role(r.rolname, new_name);
  END LOOP;
END;
$$;

-- ============================================================================
-- Step 4: Update password in init-db grants (if kolaybase role was the owner)
-- ============================================================================

-- Grant keycloak DB access to the renamed role
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'keycloak') THEN
    EXECUTE 'GRANT ALL PRIVILEGES ON DATABASE keycloak TO basefyio';
    RAISE NOTICE 'Granted keycloak access to basefyio role';
  END IF;
END;
$$;

-- ============================================================================
-- Done. Now run the Prisma migration to update the projects table metadata.
-- ============================================================================
