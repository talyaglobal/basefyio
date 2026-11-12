/**
 * Database management for a project database: schemas, columns, indexes,
 * triggers, functions, enums, extensions and roles, plus the metadata the RPC
 * endpoint needs. DDL runs as the project's own DB user (owner of its
 * objects); extensions install via the platform admin connection because
 * CREATE EXTENSION needs superuser, gated by an explicit allowlist.
 *
 * A Postgres error raised by one of these statements — an unknown column, a
 * syntax error in a function body, an object something else depends on — is
 * the caller's to fix, so it goes back as a 4xx carrying Postgres' own message
 * (see toUserFacingPgError) instead of a bare 500.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserFacingPgError } from './pg-user-error.util';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Postgres truncates longer identifiers silently (NAMEDATALEN - 1 bytes). */
const MAX_IDENT_LENGTH = 63;

/** Commonly useful extensions that are safe to enable on a shared cluster. */
export const ALLOWED_EXTENSIONS = new Set([
  'uuid-ossp', 'pgcrypto', 'pg_trgm', 'citext', 'hstore', 'unaccent',
  'fuzzystrmatch', 'btree_gin', 'btree_gist', 'intarray', 'ltree',
  'tablefunc', 'cube', 'earthdistance', 'vector',
]);

/**
 * Schemas basefyio itself depends on in every project database, with the
 * reason shown when someone tries to drop one.
 */
export const PROTECTED_SCHEMAS: ReadonlyMap<string, string> = new Map([
  ['public', 'it holds the tables and functions the REST API serves'],
  ['auth', 'it holds the helpers (auth.uid(), auth.jwt(), auth.role()) that row-level security policies call'],
  ['nosql', 'it stores the project\'s document collections'],
]);

/** SQL predicate: `col` names a schema that belongs to the project, not to Postgres. */
const userSchema = (col: string) =>
  `${col} NOT IN ('pg_catalog', 'information_schema') AND ${col} NOT LIKE 'pg\\_%'`;

function isSystemSchemaName(name: string): boolean {
  return name === 'information_schema' || /^pg_/i.test(name);
}

/**
 * A string as a Postgres literal. DDL such as CREATE TYPE … AS ENUM cannot take
 * bind parameters, so values are quoted here: single quotes are doubled and,
 * when a backslash is present, the E'' form with doubled backslashes is used
 * so the result is the same whatever standard_conforming_strings says.
 */
export function sqlLiteral(value: string): string {
  if (value.includes('\0')) {
    throw new BadRequestException('Values cannot contain NUL characters');
  }
  let hasBackslash = false;
  let out = "'";
  for (const ch of value) {
    if (ch === "'") {
      out += "''";
    } else if (ch === '\\') {
      out += '\\\\';
      hasBackslash = true;
    } else {
      out += ch;
    }
  }
  out += "'";
  return hasBackslash ? `E${out}` : out;
}

@Injectable()
export class ProjectDatabaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private ident(name: unknown, what: string): string {
    // typeof first: RegExp.test(undefined) tests the string "undefined" and passes.
    if (typeof name !== 'string' || !IDENT_RE.test(name)) {
      throw new BadRequestException(`Invalid ${what} name`);
    }
    return `"${name}"`;
  }

  /** ident() plus the length limit, for names this service creates from scratch. */
  private newIdent(raw: unknown, what: string): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) throw new BadRequestException(`A ${what} name is required`);
    if (!IDENT_RE.test(name)) {
      throw new BadRequestException(
        `Invalid ${what} name "${name}": use letters, digits and underscores, starting with a letter or underscore`,
      );
    }
    if (name.length > MAX_IDENT_LENGTH) {
      throw new BadRequestException(`The ${what} name must be at most ${MAX_IDENT_LENGTH} characters`);
    }
    return `"${name}"`;
  }

  /** Shared with ProjectPoliciesService, which manages RLS policies the same way. */
  async withProjectDb<T>(
    projectId: string,
    userId: string | undefined,
    fn: (client: PoolClient) => Promise<T>,
    asAdmin = false,
  ): Promise<T> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (userId) {
      const m = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!m) throw new NotFoundException('Project not found');
    }
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: asAdmin ? this.config.get<string>('database.user') : project.dbUser,
      password: asAdmin
        ? this.config.get<string>('database.password')
        : project.dbPassword,
      database: project.dbName,
      statement_timeout: 30_000,
    });
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      // A refused connection must not leave the pool (and its timers) behind.
      await pool.end().catch(() => undefined);
      throw err;
    }
    try {
      return await fn(client);
    } finally {
      client.release();
      await pool.end().catch(() => undefined);
    }
  }

  /**
   * withProjectDb for one dashboard action: a Postgres error from `fn` becomes
   * a 4xx whose message starts with `action`. Pass `sql` when the statement is
   * the user's own text, so a syntax error can point at its line and column.
   */
  private async run<T>(
    projectId: string,
    userId: string | undefined,
    action: string,
    fn: (client: PoolClient) => Promise<T>,
    opts: { sql?: string; asAdmin?: boolean } = {},
  ): Promise<T> {
    try {
      return await this.withProjectDb(projectId, userId, fn, opts.asAdmin ?? false);
    } catch (err) {
      throw toUserFacingPgError(err, { sql: opts.sql, prefix: action });
    }
  }

  // ── Schemas ──────────────────────────────────────────────

  async listSchemas(projectId: string, userId?: string) {
    return this.run(projectId, userId, 'Failed to load schemas', async (c) => {
      const r = await c.query(`
        SELECT n.nspname AS name,
               CASE WHEN o.rolsuper AND o.rolname <> current_user THEN NULL
                    ELSE o.rolname::text END AS owner,
               (SELECT count(*)::int FROM pg_class cls
                 WHERE cls.relnamespace = n.oid AND cls.relkind IN ('r', 'p')) AS "tableCount",
               obj_description(n.oid, 'pg_namespace') AS comment
        FROM pg_namespace n
        JOIN pg_roles o ON o.oid = n.nspowner
        WHERE ${userSchema('n.nspname')}
        ORDER BY (n.nspname <> 'public'), n.nspname`);
      return r.rows.map((row) => ({ ...row, protected: PROTECTED_SCHEMAS.has(row.name) }));
    });
  }

  async createSchema(projectId: string, userId: string | undefined, body: { name: string }) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const ident = this.newIdent(name, 'schema');
    if (isSystemSchemaName(name)) {
      throw new BadRequestException('Schema names starting with "pg_" and "information_schema" are reserved by Postgres');
    }
    const sql = `CREATE SCHEMA ${ident}`;
    return this.run(projectId, userId, 'Failed to create schema', async (c) => {
      await c.query(sql);
      return { message: 'Schema created' };
    });
  }

  async dropSchema(projectId: string, userId: string | undefined, name: string, cascade = false) {
    const ident = this.ident((name || '').trim(), 'schema');
    const plain = ident.slice(1, -1);
    const reason = PROTECTED_SCHEMAS.get(plain);
    if (reason) {
      throw new BadRequestException(`The "${plain}" schema cannot be dropped: ${reason}.`);
    }
    if (isSystemSchemaName(plain)) {
      throw new BadRequestException(`"${plain}" is a Postgres system schema and cannot be dropped`);
    }
    const sql = `DROP SCHEMA ${ident} ${cascade ? 'CASCADE' : 'RESTRICT'}`;
    return this.run(projectId, userId, 'Failed to drop schema', async (c) => {
      await c.query(sql);
      return { message: 'Schema dropped' };
    });
  }

  // ── Columns ──────────────────────────────────────────────

  /** Every column of every table in the project's own schemas. */
  async listColumns(projectId: string, userId?: string) {
    return this.run(projectId, userId, 'Failed to load columns', async (c) => {
      const r = await c.query(`
        SELECT n.nspname AS schema, cls.relname AS table, a.attname AS column,
               a.attnum AS position,
               format_type(a.atttypid, a.atttypmod) AS "dataType",
               t.typname AS "udtName",
               NOT a.attnotnull AS nullable,
               CASE
                 WHEN a.attidentity = 'a' THEN 'GENERATED ALWAYS AS IDENTITY'
                 WHEN a.attidentity = 'd' THEN 'GENERATED BY DEFAULT AS IDENTITY'
                 WHEN a.attgenerated = 's'
                   THEN 'GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                 ELSE pg_get_expr(d.adbin, d.adrelid)
               END AS "default",
               EXISTS (
                 SELECT 1 FROM pg_index i
                  WHERE i.indrelid = cls.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
               ) AS "isPrimaryKey"
        FROM pg_attribute a
        JOIN pg_class cls ON cls.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = cls.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE cls.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
          AND ${userSchema('n.nspname')}
        ORDER BY (n.nspname <> 'public'), n.nspname, cls.relname, a.attnum`);
      return r.rows;
    });
  }

  // ── Indexes ──────────────────────────────────────────────

  async listIndexes(projectId: string, userId?: string) {
    return this.run(projectId, userId, 'Failed to load indexes', async (c) => {
      const r = await c.query(`
        SELECT i.indexname AS name, i.tablename AS table, i.indexdef AS definition,
               idx.indisunique AS "isUnique", idx.indisprimary AS "isPrimary",
               pg_size_pretty(pg_relation_size(cls.oid)) AS size
        FROM pg_indexes i
        JOIN pg_namespace ns ON ns.nspname = i.schemaname
        JOIN pg_class cls ON cls.relname = i.indexname AND cls.relnamespace = ns.oid
        JOIN pg_index idx ON idx.indexrelid = cls.oid
        WHERE i.schemaname = 'public'
        ORDER BY i.tablename, i.indexname`);
      return r.rows;
    });
  }

  async createIndex(
    projectId: string,
    userId: string | undefined,
    body: { table: string; columns: string[]; unique?: boolean; method?: string; name?: string },
  ) {
    const table = this.ident(body.table, 'table');
    if (!Array.isArray(body.columns) || !body.columns.length) {
      throw new BadRequestException('At least one column required');
    }
    const cols = body.columns.map((col) => this.ident(col, 'column')).join(', ');
    const method = (body.method || 'btree').toLowerCase();
    if (!['btree', 'hash', 'gin', 'gist', 'brin'].includes(method)) {
      throw new BadRequestException('Invalid index method');
    }
    // A chosen name goes through newIdent so a long one is refused instead of
    // being silently truncated by Postgres into a name the user never typed.
    const name = typeof body.name === 'string' && body.name.trim()
      ? this.newIdent(body.name, 'index')
      : this.ident(`idx_${body.table}_${body.columns.join('_')}`.slice(0, 60), 'index');
    const unique = body.unique ? 'UNIQUE ' : '';
    return this.run(projectId, userId, 'Failed to create index', async (c) => {
      await c.query(`CREATE ${unique}INDEX ${name} ON ${table} USING ${method} (${cols})`);
      return { message: 'Index created' };
    });
  }

  async dropIndex(projectId: string, userId: string | undefined, name: string) {
    const ident = this.ident(name, 'index');
    return this.run(projectId, userId, 'Failed to drop index', async (c) => {
      await c.query(`DROP INDEX ${ident}`);
      return { message: 'Index dropped' };
    });
  }

  // ── Triggers ─────────────────────────────────────────────

  async listTriggers(projectId: string, userId?: string) {
    return this.run(projectId, userId, 'Failed to load triggers', async (c) => {
      const r = await c.query(`
        SELECT t.tgname AS name, cls.relname AS table,
               pg_get_triggerdef(t.oid) AS definition, t.tgenabled != 'D' AS enabled
        FROM pg_trigger t
        JOIN pg_class cls ON cls.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = cls.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
        ORDER BY cls.relname, t.tgname`);
      return r.rows;
    });
  }

  /**
   * Functions a trigger can execute: they return `trigger` and take no
   * declared arguments. Functions that belong to an extension are left out —
   * those expect trigger arguments this form cannot pass.
   */
  async listTriggerFunctions(projectId: string, userId?: string) {
    return this.run(projectId, userId, 'Failed to load trigger functions', async (c) => {
      const r = await c.query(`
        SELECT n.nspname AS schema, p.proname AS name, l.lanname AS language
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE p.prorettype = 'trigger'::regtype AND p.prokind = 'f' AND p.pronargs = 0
          AND ${userSchema('n.nspname')}
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend dep
             WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'e'
          )
        ORDER BY (n.nspname <> 'public'), n.nspname, p.proname`);
      return r.rows;
    });
  }

  async createTrigger(
    projectId: string,
    userId: string | undefined,
    body: {
      name: string; table: string; timing: 'BEFORE' | 'AFTER';
      events: ('INSERT' | 'UPDATE' | 'DELETE')[]; functionName: string;
      forEach?: 'ROW' | 'STATEMENT';
      /** Schema of the trigger function; unqualified (search path) when omitted. */
      functionSchema?: string;
    },
  ) {
    const name = this.newIdent(body.name, 'trigger');
    const table = this.ident(body.table, 'table');
    const fn = this.ident(body.functionName, 'function');
    const fnSchema = body.functionSchema?.trim()
      ? `${this.ident(body.functionSchema.trim(), 'schema')}.`
      : '';
    if (!['BEFORE', 'AFTER'].includes(body.timing)) throw new BadRequestException('Invalid timing');
    const events = (body.events || []).filter((e) => ['INSERT', 'UPDATE', 'DELETE'].includes(e));
    if (!events.length) throw new BadRequestException('At least one event required');
    const forEach = body.forEach === 'STATEMENT' ? 'STATEMENT' : 'ROW';
    return this.run(projectId, userId, 'Failed to create trigger', async (c) => {
      await c.query(
        `CREATE TRIGGER ${name} ${body.timing} ${events.join(' OR ')} ON ${table} FOR EACH ${forEach} EXECUTE FUNCTION ${fnSchema}${fn}()`,
      );
      return { message: 'Trigger created' };
    });
  }

  async toggleTrigger(
    projectId: string, userId: string | undefined,
    body: { name: string; table: string; enabled: boolean },
  ) {
    const name = this.ident(body.name, 'trigger');
    const table = this.ident(body.table, 'table');
    const action = body.enabled ? 'Failed to enable trigger' : 'Failed to disable trigger';
    return this.run(projectId, userId, action, async (c) => {
      await c.query(`ALTER TABLE ${table} ${body.enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${name}`);
      return { message: `Trigger ${body.enabled ? 'enabled' : 'disabled'}` };
    });
  }

  async dropTrigger(
    projectId: string, userId: string | undefined,
    body: { name: string; table: string },
  ) {
    const name = this.ident(body.name, 'trigger');
    const table = this.ident(body.table, 'table');
    return this.run(projectId, userId, 'Failed to drop trigger', async (c) => {
      await c.query(`DROP TRIGGER ${name} ON ${table}`);
      return { message: 'Trigger dropped' };
    });
  }

  // ── Functions ────────────────────────────────────────────

  async listFunctions(projectId: string, userId?: string) {
    return this.run(projectId, userId, 'Failed to load functions', async (c) => {
      const r = await c.query(`
        SELECT p.proname AS name,
               pg_get_function_identity_arguments(p.oid) AS args,
               pg_get_function_result(p.oid) AS returns,
               l.lanname AS language,
               pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND l.lanname IN ('sql', 'plpgsql')
        ORDER BY p.proname`);
      return r.rows;
    });
  }

  /** Raw CREATE [OR REPLACE] FUNCTION DDL, validated to be exactly that. */
  async createFunction(projectId: string, userId: string | undefined, sql: string) {
    const trimmed = (sql || '').trim();
    if (!/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s/i.test(trimmed)) {
      throw new BadRequestException('Body must be a single CREATE [OR REPLACE] FUNCTION statement');
    }
    // Postgres reports error positions relative to the text it was sent, which
    // is exactly `trimmed` — so line/column point into the user's statement.
    return this.run(
      projectId,
      userId,
      'Failed to create function',
      async (c) => {
        await c.query(trimmed);
        return { message: 'Function created' };
      },
      { sql: trimmed },
    );
  }

  async dropFunction(projectId: string, userId: string | undefined, name: string, args?: string) {
    const ident = this.ident(name, 'function');
    // args comes from pg_get_function_identity_arguments — already canonical.
    const safeArgs = (args || '').replace(/[;'"\\]/g, '');
    return this.run(projectId, userId, 'Failed to drop function', async (c) => {
      await c.query(`DROP FUNCTION ${ident}(${safeArgs})`);
      return { message: 'Function dropped' };
    });
  }

  // ── Enums ────────────────────────────────────────────────

  async listEnums(projectId: string, userId?: string) {
    return this.run(projectId, userId, 'Failed to load enums', async (c) => {
      const r = await c.query(`
        SELECT n.nspname AS schema, t.typname AS name,
               COALESCE(
                 (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
                    FROM pg_enum e WHERE e.enumtypid = t.oid),
                 '{}'::text[]
               ) AS values,
               (SELECT count(*)::int FROM pg_attribute a
                  JOIN pg_class cls ON cls.oid = a.attrelid
                 WHERE a.atttypid IN (t.oid, t.typarray) AND a.attnum > 0 AND NOT a.attisdropped
                   AND cls.relkind IN ('r', 'p', 'v', 'm', 'f')) AS "columnCount"
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typtype = 'e' AND ${userSchema('n.nspname')}
        ORDER BY (n.nspname <> 'public'), n.nspname, t.typname`);
      return r.rows;
    });
  }

  /** Validated, quoted enum labels: non-empty, unique, at most 63 bytes each. */
  private enumLabels(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestException('An enum needs at least one value');
    }
    if (raw.length > 1000) throw new BadRequestException('An enum can have at most 1000 values');
    const seen = new Set<string>();
    return raw.map((v) => {
      const label = this.enumLabel(v);
      if (seen.has(label)) throw new BadRequestException(`Duplicate enum value "${label}"`);
      seen.add(label);
      return label;
    });
  }

  private enumLabel(v: unknown): string {
    if (typeof v !== 'string' || v.length === 0) {
      throw new BadRequestException('Enum values must be non-empty text');
    }
    if (Buffer.byteLength(v, 'utf8') > MAX_IDENT_LENGTH) {
      throw new BadRequestException(`Enum value "${v}" is too long (at most ${MAX_IDENT_LENGTH} bytes)`);
    }
    return v;
  }

  private enumType(schema: unknown, name: unknown): { schema: string; name: string; qualified: string } {
    const s = typeof schema === 'string' && schema.trim() ? schema.trim() : 'public';
    const n = typeof name === 'string' ? name.trim() : '';
    const qualified = `${this.newIdent(s, 'schema')}.${this.newIdent(n, 'enum')}`;
    if (isSystemSchemaName(s)) {
      throw new BadRequestException(`"${s}" is a Postgres system schema; enums there cannot be managed`);
    }
    return { schema: s, name: n, qualified };
  }

  async createEnum(
    projectId: string,
    userId: string | undefined,
    body: { schema?: string; name: string; values: string[] },
  ) {
    const { qualified } = this.enumType(body?.schema, body?.name);
    const labels = this.enumLabels(body?.values);
    const sql = `CREATE TYPE ${qualified} AS ENUM (${labels.map(sqlLiteral).join(', ')})`;
    return this.run(projectId, userId, 'Failed to create enum', async (c) => {
      await c.query(sql);
      return { message: 'Enum created' };
    });
  }

  /** ALTER TYPE … ADD VALUE, optionally placed BEFORE or AFTER an existing value. */
  async addEnumValue(
    projectId: string,
    userId: string | undefined,
    schema: string,
    name: string,
    body: { value: string; before?: string; after?: string },
  ) {
    const { qualified } = this.enumType(schema, name);
    const value = this.enumLabel(body?.value);
    if (body?.before && body?.after) {
      throw new BadRequestException('Use either "before" or "after", not both');
    }
    let placement = '';
    if (body?.before) placement = ` BEFORE ${sqlLiteral(this.enumLabel(body.before))}`;
    else if (body?.after) placement = ` AFTER ${sqlLiteral(this.enumLabel(body.after))}`;
    const sql = `ALTER TYPE ${qualified} ADD VALUE ${sqlLiteral(value)}${placement}`;
    return this.run(projectId, userId, 'Failed to add enum value', async (c) => {
      await c.query(sql);
      return { message: 'Enum value added' };
    });
  }

  async dropEnum(projectId: string, userId: string | undefined, schema: string, name: string) {
    const t = this.enumType(schema, name);
    return this.run(projectId, userId, 'Failed to drop enum', async (c) => {
      // DROP TYPE would drop any type; only enums are managed here.
      const found = await c.query(
        `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typtype = 'e' AND n.nspname = $1 AND t.typname = $2`,
        [t.schema, t.name],
      );
      if (!found.rowCount) throw new NotFoundException(`Enum "${t.schema}.${t.name}" not found`);
      await c.query(`DROP TYPE ${t.qualified}`);
      return { message: 'Enum dropped' };
    });
  }

  // ── Roles ────────────────────────────────────────────────

  /**
   * Roles that can reach this database, read-only. The cluster may be shared
   * between projects, so this is not all of pg_roles: it is the project's own
   * role, the roles it belongs to or that belong to it (anon, authenticated,
   * service_role …), and roles holding a grant, a policy or an object in this
   * database. Platform superusers are not listed. Built-in pg_* roles are the
   * same on every server and are added when `includeSystem` is set.
   */
  async listRoles(projectId: string, userId?: string, opts: { includeSystem?: boolean } = {}) {
    return this.run(projectId, userId, 'Failed to load roles', async (c) => {
      const r = await c.query(
        `
        WITH related AS (
          SELECT r.oid FROM pg_roles r
           WHERE r.rolname = current_user
              OR pg_has_role(current_user, r.oid, 'MEMBER')
              OR pg_has_role(r.oid, current_user, 'MEMBER')
          UNION
          SELECT a.grantee FROM pg_database d, aclexplode(d.datacl) a
           WHERE d.datname = current_database()
          UNION
          SELECT unnest(p.polroles) FROM pg_policy p
          UNION
          SELECT a.grantee FROM pg_namespace n, aclexplode(n.nspacl) a
           WHERE ${userSchema('n.nspname')}
          UNION
          SELECT n.nspowner FROM pg_namespace n
           WHERE ${userSchema('n.nspname')}
          UNION
          SELECT a.grantee FROM pg_class cls
            JOIN pg_namespace n ON n.oid = cls.relnamespace,
            aclexplode(cls.relacl) a
           WHERE ${userSchema('n.nspname')}
          UNION
          SELECT cls.relowner FROM pg_class cls
            JOIN pg_namespace n ON n.oid = cls.relnamespace
           WHERE ${userSchema('n.nspname')}
        )
        SELECT r.rolname AS name,
               r.rolcanlogin AS "canLogin",
               r.rolsuper AS superuser,
               r.rolcreaterole AS "createRole",
               r.rolcreatedb AS "createDb",
               r.rolbypassrls AS "bypassRls",
               r.rolconnlimit AS "connectionLimit",
               (r.rolname = current_user) AS "isCurrentUser",
               (r.rolname LIKE 'pg\\_%') AS "isSystem",
               ARRAY(
                 SELECT b.rolname::text FROM pg_auth_members m
                   JOIN pg_roles b ON b.oid = m.roleid
                  WHERE m.member = r.oid AND NOT b.rolsuper
                  ORDER BY 1
               ) AS "memberOf"
        FROM pg_roles r
        WHERE (NOT r.rolsuper OR r.rolname = current_user)
          AND (
            (r.rolname NOT LIKE 'pg\\_%' AND r.oid IN (SELECT oid FROM related))
            OR ($1::boolean AND r.rolname LIKE 'pg\\_%')
          )
        ORDER BY (r.rolname LIKE 'pg\\_%'), (r.rolname <> current_user), r.rolname`,
        [Boolean(opts.includeSystem)],
      );
      return r.rows;
    });
  }

  // ── Extensions ───────────────────────────────────────────

  async listExtensions(projectId: string, userId?: string) {
    return this.run(projectId, userId, 'Failed to load extensions', async (c) => {
      const r = await c.query(`
        SELECT name, default_version AS "defaultVersion", installed_version AS "installedVersion", comment
        FROM pg_available_extensions ORDER BY name`);
      return r.rows
        .filter((row) => ALLOWED_EXTENSIONS.has(row.name))
        .map((row) => ({ ...row, enabled: row.installedVersion !== null }));
    });
  }

  async setExtension(
    projectId: string, userId: string | undefined,
    body: { name: string; enabled: boolean },
  ) {
    if (!ALLOWED_EXTENSIONS.has(body.name)) {
      throw new BadRequestException('Extension is not in the allowed list');
    }
    const ident = `"${body.name}"`;
    // CREATE EXTENSION needs superuser → run via the platform admin connection.
    return this.run(
      projectId,
      userId,
      body.enabled ? 'Failed to enable extension' : 'Failed to disable extension',
      async (c) => {
        if (body.enabled) {
          await c.query(`CREATE EXTENSION IF NOT EXISTS ${ident}`);
        } else {
          await c.query(`DROP EXTENSION IF EXISTS ${ident}`);
        }
        return { message: `Extension ${body.enabled ? 'enabled' : 'disabled'}` };
      },
      { asAdmin: true },
    );
  }
}
