/**
 * Which schemas the REST data API serves for a project (#264).
 *
 * `public` is always served and always comes first, so a request without a
 * profile header reads and writes `public` exactly as before the setting
 * existed. A project may list extra schemas (Settings → API → Exposed schemas);
 * a PostgREST client then picks one per request with `Accept-Profile` (GET,
 * HEAD) or `Content-Profile` (POST, PATCH, DELETE). A schema that is not listed
 * answers 406 PGRST106 naming the ones that are.
 *
 * Exposing a schema grants nothing: the API roles (`anon`, `authenticated`,
 * `service_role`) still need `USAGE` on the schema and privileges on its
 * tables, and row-level security applies as it does in `public`.
 *
 * System and platform schemas can never be listed: the Postgres catalogs, the
 * auth and storage internals, extension schemas and basefyio's own. Names are
 * plain identifiers only, so nothing stored here can become SQL text other than
 * a double-quoted identifier.
 *
 * Pure: no connection, no Nest.
 */

/** Always served, always first; never stored in the setting. */
export const DEFAULT_PROFILE = 'public';

/** Upper bound on extra schemas per project. */
export const MAX_EXPOSED_SCHEMAS = 10;

/** A plain identifier: letters, digits, underscore; at most 63 bytes (Postgres NAMEDATALEN). */
const SCHEMA_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Schemas that are never served, compared in lower case. */
const RESERVED_SCHEMAS: ReadonlySet<string> = new Set([
  'information_schema',
  // auth, storage and realtime internals of the project database
  'auth',
  'storage',
  'realtime',
  // basefyio's own schemas in the project database
  'nosql',
  'basefyio_internal',
  // extension and tooling schemas
  'extensions',
  'graphql',
  'graphql_public',
  'vault',
  'pgsodium',
  'pgsodium_masks',
  'pgbouncer',
  'pgmq',
  'net',
  'cron',
  'topology',
  'tiger',
  'tiger_data',
  'repack',
  'timescaledb_information',
  'timescaledb_experimental',
  'supabase_functions',
  'supabase_migrations',
]);

/** Prefixes that are never served: catalogs (`pg_catalog`, `pg_toast`, `pg_temp_*`),
 *  internal schemas (`_realtime`, `_timescaledb_*`), and platform names. */
const RESERVED_PREFIXES = ['pg_', '_', 'basefyio', 'kolaybase', 'supabase_'];

/** Why a schema name cannot be exposed, or null when it can. */
export function exposedSchemaProblem(name: string): string | null {
  if (typeof name !== 'string' || !SCHEMA_IDENT.test(name)) {
    return `"${String(name).slice(0, 80)}" is not a valid schema name. Use letters, digits and underscores, starting with a letter or underscore (at most 63 characters).`;
  }
  const lower = name.toLowerCase();
  if (RESERVED_SCHEMAS.has(lower) || RESERVED_PREFIXES.some((p) => lower.startsWith(p))) {
    return `"${name}" is a system or platform schema and cannot be exposed through the REST API.`;
  }
  return null;
}

export class ExposedSchemasError extends Error {}

/**
 * Validate the setting as sent by the dashboard. Returns the list to store:
 * de-duplicated, in the order given, with `public` left out (it is always
 * served). Throws {@link ExposedSchemasError} naming the first problem.
 */
export function validateExposedSchemas(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ExposedSchemasError('exposedSchemas must be an array of schema names.');
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new ExposedSchemasError('exposedSchemas must be an array of schema names.');
    }
    const name = raw.trim();
    if (name === DEFAULT_PROFILE) continue;
    const problem = exposedSchemaProblem(name);
    if (problem) throw new ExposedSchemasError(problem);
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MAX_EXPOSED_SCHEMAS) {
    throw new ExposedSchemasError(`At most ${MAX_EXPOSED_SCHEMAS} extra schemas can be exposed.`);
  }
  return out;
}

/**
 * The schemas a request may choose from: `public`, then the stored extras.
 * The stored list is checked again here, so a value that reached the column
 * some other way is ignored rather than served.
 */
export function exposedProfiles(stored: readonly string[] | null | undefined): string[] {
  const out = [DEFAULT_PROFILE];
  for (const name of stored ?? []) {
    if (typeof name === 'string' && name !== DEFAULT_PROFILE && exposedSchemaProblem(name) === null && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

export type ProfileChoice = { ok: true; schema: string } | { ok: false; message: string };

/**
 * The schema a request runs against. No header means the first exposed schema
 * (`public`), as PostgREST does. A header must name an exposed schema exactly;
 * the comparison is against the allow-list, so the header value never reaches SQL.
 */
export function chooseProfile(requested: string | undefined, exposed: readonly string[]): ProfileChoice {
  if (requested === undefined) return { ok: true, schema: exposed[0] ?? DEFAULT_PROFILE };
  if (exposed.includes(requested)) return { ok: true, schema: requested };
  return { ok: false, message: `The schema must be one of the following: ${exposed.join(', ')}` };
}

/** `"name"` in `public` (the SQL the API has always written), `"schema"."name"` elsewhere. */
export function qualifiedRelation(schema: string | undefined, name: string): string {
  return !schema || schema === DEFAULT_PROFILE ? `"${name}"` : `"${schema}"."${name}"`;
}

/** What the settings route answers: every served schema, and the stored extras. */
export function restSchemasView(stored: readonly string[] | null | undefined): {
  schemas: string[];
  exposedSchemas: string[];
} {
  const schemas = exposedProfiles(stored);
  return { schemas, exposedSchemas: schemas.slice(1) };
}
