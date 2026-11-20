/**
 * Data access settings of a project: whether the REST data API serves it, whether new
 * `public` tables are granted to the API roles automatically, and whether new tables get
 * row-level security switched on by an event trigger.
 *
 * Pure: no connection, no Nest. The RLS bootstrap (`sql/rls-bootstrap.sql`) is rendered
 * through `renderRlsBootstrap`, and Settings → Data access applies `renderDataAccessSql`
 * on its own, so the create path and the settings path install the same statements.
 */

export interface DataAccessFlags {
  /** The REST data API (`/api/rest/v1`, `/api/rest/v1/collections`) serves this project. */
  dataApi: boolean;
  /** Default privileges grant new `public` tables and sequences to `anon` / `authenticated`. */
  autoGrantNewTables: boolean;
  /** An event trigger enables row-level security on every new `public` table. */
  rlsOnNewTables: boolean;
}

/** What every project had before the setting existed; existing rows keep it. */
export const DEFAULT_DATA_ACCESS: DataAccessFlags = {
  dataApi: true,
  autoGrantNewTables: true,
  rlsOnNewTables: false,
};

/** The project row's columns, as flags. Missing columns read as the defaults. */
export function dataAccessOf(row: {
  dataApiEnabled?: boolean | null;
  autoGrantNewTables?: boolean | null;
  rlsOnNewTables?: boolean | null;
}): DataAccessFlags {
  return {
    dataApi: row.dataApiEnabled ?? DEFAULT_DATA_ACCESS.dataApi,
    autoGrantNewTables: row.autoGrantNewTables ?? DEFAULT_DATA_ACCESS.autoGrantNewTables,
    rlsOnNewTables: row.rlsOnNewTables ?? DEFAULT_DATA_ACCESS.rlsOnNewTables,
  };
}

export function withDataAccessDefaults(partial?: Partial<DataAccessFlags> | null): DataAccessFlags {
  return {
    dataApi: partial?.dataApi ?? DEFAULT_DATA_ACCESS.dataApi,
    autoGrantNewTables: partial?.autoGrantNewTables ?? DEFAULT_DATA_ACCESS.autoGrantNewTables,
    rlsOnNewTables: partial?.rlsOnNewTables ?? DEFAULT_DATA_ACCESS.rlsOnNewTables,
  };
}

/** Name of the event trigger that enables RLS on new tables. */
export const RLS_ON_NEW_TABLES_TRIGGER = 'bf_rls_on_new_tables';
/** Schema that holds the trigger's function; not reachable by the API roles. */
export const DATA_ACCESS_SCHEMA = 'basefyio_internal';

const OWNER_RE = /^[a-z0-9_]+$/;

function assertOwner(owner: string): void {
  if (!OWNER_RE.test(owner)) throw new Error('Invalid project owner identifier');
}

/**
 * The statements that put a project's data access settings into its database.
 * Idempotent; runs as the database admin (the event trigger needs a superuser).
 *
 * - `autoGrantNewTables` adds or removes the `anon` / `authenticated` default privileges on
 *   `public` tables and sequences. `service_role` keeps its own in the bootstrap. Tables that
 *   already exist keep the grants they have: the setting is about new tables.
 * - `rlsOnNewTables` installs or drops the `ddl_command_end` event trigger.
 */
export function renderDataAccessSql(owner: string, flags: DataAccessFlags): string {
  assertOwner(owner);
  const parts: string[] = [];
  if (flags.autoGrantNewTables) {
    parts.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO authenticated;`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO authenticated;`,
    );
  } else {
    parts.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM anon, authenticated;`,
    );
  }

  if (flags.rlsOnNewTables) {
    parts.push(
      `CREATE SCHEMA IF NOT EXISTS ${DATA_ACCESS_SCHEMA};`,
      `REVOKE ALL ON SCHEMA ${DATA_ACCESS_SCHEMA} FROM PUBLIC;`,
      `CREATE OR REPLACE FUNCTION ${DATA_ACCESS_SCHEMA}.enable_rls_on_new_table()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $bf_rls_fn$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE object_type = 'table' AND schema_name = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END;
$bf_rls_fn$;`,
      `REVOKE ALL ON FUNCTION ${DATA_ACCESS_SCHEMA}.enable_rls_on_new_table()
  FROM PUBLIC, anon, authenticated, service_role, "${owner}";`,
      `DO $bf_rls_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = '${RLS_ON_NEW_TABLES_TRIGGER}') THEN
    CREATE EVENT TRIGGER ${RLS_ON_NEW_TABLES_TRIGGER} ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      EXECUTE FUNCTION ${DATA_ACCESS_SCHEMA}.enable_rls_on_new_table();
  END IF;
END$bf_rls_trigger$;`,
    );
  } else {
    parts.push(
      `DO $bf_rls_trigger_off$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = '${RLS_ON_NEW_TABLES_TRIGGER}') THEN
    DROP EVENT TRIGGER ${RLS_ON_NEW_TABLES_TRIGGER};
  END IF;
END$bf_rls_trigger_off$;`,
    );
  }
  return parts.join('\n\n');
}

const AUTO_GRANT_SECTION = /^-- \{\{#autoGrant\}\}[^\n]*\n[\s\S]*?^-- \{\{\/autoGrant\}\}[^\n]*$/gm;
const SECTION_MARKER = /^-- \{\{[#/]autoGrant\}\}[^\n]*$/gm;
const DATA_ACCESS_PLACEHOLDER = /^-- %BF_DATA_ACCESS%[^\n]*$/m;

/**
 * Turn `sql/rls-bootstrap.sql` into the statements for one project.
 *
 * The template carries two things beyond `%BF_PROJECT_OWNER%`: a `-- {{#autoGrant}}` …
 * `-- {{/autoGrant}}` section (the grants on tables that already exist, kept only while
 * new tables are granted automatically, so re-running the bootstrap never re-grants tables
 * the owner took access away from) and the `-- %BF_DATA_ACCESS%` line, where
 * `renderDataAccessSql` goes.
 */
export function renderRlsBootstrap(template: string, owner: string, flags: DataAccessFlags): string {
  assertOwner(owner);
  if (!DATA_ACCESS_PLACEHOLDER.test(template)) {
    throw new Error('rls-bootstrap.sql has no %BF_DATA_ACCESS% placeholder');
  }
  let sql = flags.autoGrantNewTables
    ? template.replace(SECTION_MARKER, '')
    : template.replace(AUTO_GRANT_SECTION, '');
  // A function replacement, so `$` sequences in the SQL are not read as patterns.
  const dataAccess = renderDataAccessSql(owner, flags);
  sql = sql.replace(DATA_ACCESS_PLACEHOLDER, () => dataAccess);
  return sql.replace(/%BF_PROJECT_OWNER%/g, owner);
}
