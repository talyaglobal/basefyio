/**
 * Security and performance advisors (#218): rules that read a project database's
 * catalogs and turn what they find into findings with a suggested fix.
 *
 * Pure: every rule is a catalog SELECT plus a function from its rows to findings.
 * The service runs the SELECTs in a read-only transaction; the fix SQL is only
 * shown to the user, never executed here. Identifiers in the fix SQL are quoted
 * in code (quoteIdent), so a table called `Order "x"` cannot break the statement.
 */

export type AdvisorSeverity = 'error' | 'warn' | 'info';
export type AdvisorCategory = 'security' | 'performance';

export const ADVISOR_CATEGORIES: readonly AdvisorCategory[] = ['security', 'performance'];

export interface AdvisorFinding {
  /** Stable per rule and entity, e.g. `rls_disabled:public.todos`. */
  id: string;
  ruleId: string;
  severity: AdvisorSeverity;
  category: AdvisorCategory;
  title: string;
  detail: string;
  /** `schema.table`, `schema.function(args)` or `schema.index`, unquoted, for display. */
  entity: string;
  fixSql: string;
  docsHint: string;
}

export type AdvisorRow = Record<string, unknown>;

export interface AdvisorRule {
  id: string;
  category: AdvisorCategory;
  title: string;
  /** One catalog SELECT, already bounded by ADVISOR_ROW_LIMIT. */
  sql: string;
  map(rows: AdvisorRow[]): AdvisorFinding[];
}

/** Rows read per rule; a database with more problems than this shows the first ones. */
export const ADVISOR_ROW_LIMIT = 200;

/** Unused-index rule: tables smaller than this are ignored (a seq scan is the right plan there). */
export const UNUSED_INDEX_MIN_TABLE_BYTES = 1024 * 1024;
/** Unused-index rule: statistics younger than this say nothing about an index. */
export const UNUSED_INDEX_MIN_STATS_DAYS = 7;

/**
 * Schemas the platform or Postgres own. Advisors look only at the project's own schemas.
 */
export const EXCLUDED_SCHEMAS = [
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'auth',
  'storage',
  'extensions',
  'realtime',
  '_realtime',
  'graphql',
  'graphql_public',
  'vault',
  'pgsodium',
  'pgsodium_masks',
  'pgbouncer',
  'cron',
  'net',
  'supabase_functions',
  'supabase_migrations',
  'basefyio',
] as const;

/** SQL predicate on a `pg_namespace` alias that keeps only the project's own schemas. */
export function userSchemaPredicate(nsAlias: string): string {
  const list = EXCLUDED_SCHEMAS.map((s) => `'${s}'`).join(', ');
  return (
    `${nsAlias}.nspname NOT IN (${list})` +
    ` AND ${nsAlias}.nspname NOT LIKE 'pg\\_%'` +
    ` AND ${nsAlias}.nspname NOT LIKE '\\_bf\\_%'`
  );
}

/** Object not created by an extension (pg_depend deptype 'e'). */
function notExtensionMember(catalog: string, oidExpr: string): string {
  return (
    `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass` +
    ` AND d.objid = ${oidExpr} AND d.deptype = 'e')`
  );
}

// ── Identifier quoting ─────────────────────────────────────────────────────

/** Keywords that cannot stand as a bare identifier (reserved in Postgres). */
const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check ' +
    'collate collation column concurrently constraint create cross current_catalog current_date ' +
    'current_role current_schema current_time current_timestamp current_user default deferrable desc ' +
    'distinct do else end except false fetch for foreign freeze from full grant group having ilike in ' +
    'initially inner intersect into is isnull join lateral leading left like limit localtime ' +
    'localtimestamp natural not notnull null offset on only or order outer overlaps placing primary ' +
    'references returning right select session_user similar some symmetric system_user table tablesample ' +
    'then to trailing true union unique user using variadic verbose when where window with'
  ).split(' '),
);

/** Same result as Postgres' quote_ident(): bare when safe, otherwise double-quoted with `"` doubled. */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Postgres identifiers are cut at 63 bytes; cut on a character boundary. */
export function truncateIdent(name: string, maxBytes = 63): string {
  let out = '';
  for (const ch of name) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** pg returns name[] as a JS array, or as the text `{a,b}` for some types. */
function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str);
  const s = str(v);
  if (!s) return [];
  if (s.startsWith('{') && s.endsWith('}')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => x.replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"'));
  }
  return [s];
}

function bool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Leading columns of index `i` (1-based int2[]) as a set equal to constraint `con`'s columns. */
function indexCoversFk(indexAlias: string, conAlias: string): string {
  const lead = `(string_to_array(${indexAlias}.indkey::text, ' ')::int2[])[1:cardinality(${conAlias}.conkey)]`;
  return `${lead} @> ${conAlias}.conkey AND ${lead} <@ ${conAlias}.conkey`;
}

// ── Rules ──────────────────────────────────────────────────────────────────

/** (1) + (7) A table with row-level security off. Error when anon/authenticated may write to it. */
export const rlsDisabledRule: AdvisorRule = {
  id: 'rls_disabled',
  category: 'security',
  title: 'Row-level security is off',
  sql: `
SELECT n.nspname AS schema, c.relname AS table,
  coalesce((SELECT array_agg(DISTINCT r.rolname ORDER BY r.rolname) FROM pg_roles r
     WHERE r.rolname IN ('anon', 'authenticated')
       AND (has_table_privilege(r.oid, c.oid, 'INSERT') OR has_table_privilege(r.oid, c.oid, 'UPDATE')
         OR has_table_privilege(r.oid, c.oid, 'DELETE'))), '{}') AS writers
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND NOT c.relrowsecurity
  AND ${userSchemaPredicate('n')} AND c.relname NOT LIKE '\\_bf\\_%'
  AND ${notExtensionMember('pg_class', 'c.oid')}
ORDER BY 1, 2
LIMIT ${ADVISOR_ROW_LIMIT}`,
  map(rows) {
    return rows.map((r) => {
      const schema = str(r.schema);
      const table = str(r.table);
      const writers = strArray(r.writers).filter(Boolean);
      const target = qualified(schema, table);
      const detail = writers.length
        ? `Row-level security is off on ${schema}.${table} and the ${writers.join(' and ')} role${
            writers.length > 1 ? 's' : ''
          } may insert, update or delete its rows. Anyone holding the project's public key can change this table through the data API.`
        : `Row-level security is off on ${schema}.${table}, so every role with a grant on it sees every row. Turn it on and add policies before exposing the table through the data API.`;
      return {
        id: `rls_disabled:${schema}.${table}`,
        ruleId: 'rls_disabled',
        severity: writers.length ? 'error' : 'warn',
        category: 'security',
        title: writers.length ? 'Public write access without row-level security' : 'Row-level security is off',
        detail,
        entity: `${schema}.${table}`,
        fixSql:
          `ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;\n` +
          `-- Then add policies for the rows each role may see, e.g.:\n` +
          `-- CREATE POLICY ${quoteIdent('authenticated can read')} ON ${target} FOR SELECT TO authenticated USING (true);`,
        docsHint: 'With RLS on and no policy, only the table owner can read the table. Add a policy per role and command.',
      } satisfies AdvisorFinding;
    });
  },
};

/** (2) A table with row-level security on and no policy at all. */
export const rlsNoPolicyRule: AdvisorRule = {
  id: 'rls_enabled_no_policy',
  category: 'security',
  title: 'Row-level security is on but no policy exists',
  sql: `
SELECT n.nspname AS schema, c.relname AS table
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  AND ${userSchemaPredicate('n')} AND c.relname NOT LIKE '\\_bf\\_%'
  AND ${notExtensionMember('pg_class', 'c.oid')}
ORDER BY 1, 2
LIMIT ${ADVISOR_ROW_LIMIT}`,
  map(rows) {
    return rows.map((r) => {
      const schema = str(r.schema);
      const table = str(r.table);
      const target = qualified(schema, table);
      return {
        id: `rls_enabled_no_policy:${schema}.${table}`,
        ruleId: 'rls_enabled_no_policy',
        severity: 'info',
        category: 'security',
        title: 'Row-level security is on but no policy exists',
        detail: `${schema}.${table} has row-level security on and no policy, so the data API returns no rows and refuses every write for anon and authenticated. If that is intended, nothing needs to change.`,
        entity: `${schema}.${table}`,
        fixSql:
          `-- Adjust the condition to the rows each role may see:\n` +
          `CREATE POLICY ${quoteIdent('authenticated can read')} ON ${target}\n` +
          `  FOR SELECT TO authenticated USING (true);`,
        docsHint: 'Policies are added per command (SELECT, INSERT, UPDATE, DELETE) and role. The Database page lists them per table.',
      } satisfies AdvisorFinding;
    });
  },
};

/** (3) A foreign key whose columns are not the leading columns of any index. */
export const unindexedForeignKeyRule: AdvisorRule = {
  id: 'unindexed_foreign_key',
  category: 'performance',
  title: 'Foreign key without an index',
  sql: `
SELECT n.nspname AS schema, c.relname AS table, con.conname AS constraint,
  (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype = 'f' AND NOT c.relispartition
  AND ${userSchemaPredicate('n')} AND c.relname NOT LIKE '\\_bf\\_%'
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = con.conrelid AND i.indpred IS NULL
    AND ${indexCoversFk('i', 'con')})
ORDER BY 1, 2, 3
LIMIT ${ADVISOR_ROW_LIMIT}`,
  map(rows) {
    return rows.map((r) => {
      const schema = str(r.schema);
      const table = str(r.table);
      const constraint = str(r.constraint);
      const columns = strArray(r.columns).filter(Boolean);
      const indexName = truncateIdent(`${table}_${columns.join('_')}_idx`);
      return {
        id: `unindexed_foreign_key:${schema}.${table}.${constraint}`,
        ruleId: 'unindexed_foreign_key',
        severity: 'warn',
        category: 'performance',
        title: 'Foreign key without an index',
        detail: `The foreign key ${constraint} on ${schema}.${table} (${columns.join(', ')}) has no index starting with its columns. Joins on it and every delete or key update in the referenced table scan the whole of ${table}.`,
        entity: `${schema}.${table}`,
        fixSql: `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName)} ON ${qualified(schema, table)} (${columns
          .map(quoteIdent)
          .join(', ')});`,
        docsHint: 'On a large, busy table run it as CREATE INDEX CONCURRENTLY (outside a transaction) so writes are not blocked while it builds.',
      } satisfies AdvisorFinding;
    });
  },
};

/** (4) A SECURITY DEFINER function without a pinned search_path. */
export const securityDefinerSearchPathRule: AdvisorRule = {
  id: 'security_definer_search_path',
  category: 'security',
  title: 'SECURITY DEFINER function without a fixed search_path',
  sql: `
SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) cfg WHERE cfg LIKE 'search\\_path=%')
  AND ${userSchemaPredicate('n')}
  AND ${notExtensionMember('pg_proc', 'p.oid')}
ORDER BY 1, 2, 3
LIMIT ${ADVISOR_ROW_LIMIT}`,
  map(rows) {
    return rows.map((r) => {
      const schema = str(r.schema);
      const name = str(r.name);
      // The argument list comes from pg_get_function_identity_arguments(): Postgres' own rendering.
      const args = str(r.args);
      return {
        id: `security_definer_search_path:${schema}.${name}(${args})`,
        ruleId: 'security_definer_search_path',
        severity: 'warn',
        category: 'security',
        title: 'SECURITY DEFINER function without a fixed search_path',
        detail: `${schema}.${name}(${args}) runs with its owner's rights but resolves names through the caller's search_path. A caller who can create objects in a schema on that path can make it run their code with those rights.`,
        entity: `${schema}.${name}(${args})`,
        fixSql: `ALTER FUNCTION ${qualified(schema, name)}(${args}) SET search_path = ${quoteIdent(schema)}, pg_temp;`,
        docsHint: 'Include every schema the function body uses without qualifying names, and keep pg_temp last.',
      } satisfies AdvisorFinding;
    });
  },
};

/** (5) A non-unique index that has never been scanned since statistics began. */
export const unusedIndexRule: AdvisorRule = {
  id: 'unused_index',
  category: 'performance',
  title: 'Unused index',
  sql: `
WITH stats AS (
  SELECT coalesce((SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
                  pg_postmaster_start_time()) AS since
)
SELECT s.schemaname AS schema, s.relname AS table, s.indexrelname AS index,
  pg_relation_size(s.indexrelid) AS index_bytes, stats.since AS stats_since
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
JOIN pg_namespace n ON n.nspname = s.schemaname
CROSS JOIN stats
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
  AND i.indisvalid
  AND ${userSchemaPredicate('n')} AND s.relname NOT LIKE '\\_bf\\_%'
  AND stats.since < now() - interval '${UNUSED_INDEX_MIN_STATS_DAYS} days'
  AND pg_relation_size(s.relid) >= ${UNUSED_INDEX_MIN_TABLE_BYTES}
  AND NOT EXISTS (SELECT 1 FROM pg_constraint ic WHERE ic.conindid = s.indexrelid)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.contype = 'f' AND con.conrelid = s.relid
    AND ${indexCoversFk('i', 'con')})
  AND ${notExtensionMember('pg_class', 's.indexrelid')}
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT ${ADVISOR_ROW_LIMIT}`,
  map(rows) {
    return rows.map((r) => {
      const schema = str(r.schema);
      const table = str(r.table);
      const index = str(r.index);
      const bytes = num(r.index_bytes);
      const since = r.stats_since instanceof Date ? r.stats_since.toISOString() : str(r.stats_since);
      return {
        id: `unused_index:${schema}.${index}`,
        ruleId: 'unused_index',
        severity: 'info',
        category: 'performance',
        title: 'Unused index',
        detail: `${schema}.${index} on ${table} (${formatBytes(bytes)}) has not been used by any query since ${
          since || 'statistics began'
        }. It still costs disk and slows every write to ${table}.`,
        entity: `${schema}.${index}`,
        fixSql: `DROP INDEX IF EXISTS ${qualified(schema, index)};`,
        docsHint: 'Check first that no rare job (a monthly report, a replica) relies on it; statistics count this database only.',
      } satisfies AdvisorFinding;
    });
  },
};

/** (6) A table without a primary key. */
export const noPrimaryKeyRule: AdvisorRule = {
  id: 'no_primary_key',
  category: 'performance',
  title: 'Table without a primary key',
  sql: `
SELECT n.nspname AS schema, c.relname AS table,
  EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id'
    AND a.attnum > 0 AND NOT a.attisdropped) AS has_id
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype = 'p')
  AND ${userSchemaPredicate('n')} AND c.relname NOT LIKE '\\_bf\\_%'
  AND ${notExtensionMember('pg_class', 'c.oid')}
ORDER BY 1, 2
LIMIT ${ADVISOR_ROW_LIMIT}`,
  map(rows) {
    return rows.map((r) => {
      const schema = str(r.schema);
      const table = str(r.table);
      const target = qualified(schema, table);
      const hasId = bool(r.has_id);
      return {
        id: `no_primary_key:${schema}.${table}`,
        ruleId: 'no_primary_key',
        severity: 'info',
        category: 'performance',
        title: 'Table without a primary key',
        detail: `${schema}.${table} has no primary key. Rows cannot be addressed one by one: the table editor, realtime updates and logical replication need one.`,
        entity: `${schema}.${table}`,
        fixSql: hasId
          ? `-- Fails if id has duplicates or nulls:\nALTER TABLE ${target} ADD PRIMARY KEY (id);`
          : `ALTER TABLE ${target} ADD COLUMN id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY;`,
        docsHint: 'Adding a key rewrites or scans the table; on a large table do it in a quiet hour.',
      } satisfies AdvisorFinding;
    });
  },
};

export const ADVISOR_RULES: readonly AdvisorRule[] = [
  rlsDisabledRule,
  rlsNoPolicyRule,
  securityDefinerSearchPathRule,
  unindexedForeignKeyRule,
  unusedIndexRule,
  noPrimaryKeyRule,
];

const SEVERITY_ORDER: Record<AdvisorSeverity, number> = { error: 0, warn: 1, info: 2 };

export function sortFindings(findings: AdvisorFinding[]): AdvisorFinding[] {
  return [...findings].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.entity.localeCompare(b.entity) ||
      a.id.localeCompare(b.id),
  );
}

export interface AdvisorCounts {
  total: number;
  error: number;
  warn: number;
  info: number;
  security: number;
  performance: number;
}

export function countFindings(findings: AdvisorFinding[]): AdvisorCounts {
  const counts: AdvisorCounts = { total: 0, error: 0, warn: 0, info: 0, security: 0, performance: 0 };
  for (const f of findings) {
    counts.total++;
    counts[f.severity]++;
    counts[f.category]++;
  }
  return counts;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}
