-- basefyio default extension set, installed into every new project database by
-- ProjectProvisioningService.installDefaultExtensions(), and on request into an
-- existing one from the Database page.
--
-- One statement per line. The service runs each line on its own, so an
-- extension this cluster does not ship is skipped and reported — never fatal
-- for provisioning. Everything here is created in the default schema, the same
-- place the dashboard's extension toggle puts it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
-- pg_stat_statements only works when the server preloads its library; without
-- that the view errors on every read, so it is created only where it will work.
DO $$ BEGIN IF current_setting('shared_preload_libraries') ~ 'pg_stat_statements' THEN CREATE EXTENSION IF NOT EXISTS pg_stat_statements; END IF; END $$;
