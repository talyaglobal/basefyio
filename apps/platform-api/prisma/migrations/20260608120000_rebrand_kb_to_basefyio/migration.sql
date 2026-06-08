-- Rebrand: rename all kb_ prefixed database names, users, and keycloak realms
-- to basefyio_ / basefyio- prefix.
--
-- This migration updates the platform metadata only (the "projects" table).
-- The actual PostgreSQL database/user renames and Keycloak realm renames are
-- handled by the companion script: scripts/rebrand-rename-dbs.sql

-- 1. Rename project database names: kb_<slug> → basefyio_<slug>
UPDATE projects
SET db_name = 'basefyio_' || substring(db_name FROM 4)
WHERE db_name LIKE 'kb\_%' AND status != 'DELETED';

-- 2. Rename project database users: kb_user_<hash> → basefyio_user_<hash>
UPDATE projects
SET db_user = 'basefyio_user_' || substring(db_user FROM 9)
WHERE db_user LIKE 'kb\_user\_%' AND status != 'DELETED';

-- 3. Rename keycloak realms: kb-<slug> → basefyio-<slug>
UPDATE projects
SET keycloak_realm = 'basefyio-' || substring(keycloak_realm FROM 4)
WHERE keycloak_realm LIKE 'kb-%' AND status != 'DELETED';
