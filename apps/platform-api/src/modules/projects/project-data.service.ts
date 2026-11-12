import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeDataService } from '../realtime-data/realtime-data.service';
import {
  buildPostgresUri,
  getPgbouncerClientEndpoints,
  getPostgresDirectClientEndpoints,
} from './postgres-uri.util';
import { isPgError, toUserFacingPgError } from './pg-user-error.util';

export interface TableInfo {
  name: string;
  schema: string;
  rowCount: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimary: boolean;
  /** A single-column UNIQUE constraint or unique index covers this column. */
  isUnique?: boolean;
}

/**
 * Postgres keeps at most 63 bytes of an identifier (NAMEDATALEN - 1) and
 * silently truncates longer ones — a 76-character table name was created under
 * its first 63 characters while the dashboard kept using the full name.
 */
export const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Columns the data editor carries on every row for its own use: the physical
 * row id (edits on tables without a primary key) and the row version (xmin, to
 * notice that someone else changed the row). Never shown, never written.
 */
export const INTERNAL_ROW_FIELDS = ['_bf_ctid', '_bf_xmin'] as const;

/** Thrown with 409 when a row changed since the editor read it. */
export const ROW_CHANGED_CODE = 'ROW_CHANGED';

/** Matched with ILIKE as they are. */
const SEARCH_TEXT_TYPES = new Set(['text', 'character varying', 'character', 'name']);

/**
 * Read as text first. `uuid` used to sit with the text types and be matched
 * with ILIKE directly — Postgres has no `uuid ~~* text` operator, so every
 * search on a table with a uuid column (the common `id uuid` key) failed with
 * a 500. Enums, citext and other extension types (USER-DEFINED) are cast too.
 */
const SEARCH_CAST_TYPES = new Set([
  'uuid',
  'integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision', 'money',
  'date', 'timestamp without time zone', 'timestamp with time zone',
  'time without time zone', 'time with time zone', 'interval',
  'boolean', 'inet', 'cidr', 'macaddr', 'USER-DEFINED',
]);

/**
 * The WHERE clause of a data-editor search: an OR of ILIKEs over every column
 * that reads as text, against parameter `$paramIndex`. json/jsonb, bytea and
 * arrays are skipped — expensive to render as text and rarely what a free-text
 * search is after. No searchable column means no match rather than a scan.
 */
export function searchWhereClause(
  columns: { column_name: string; data_type: string }[],
  paramIndex: number,
): string {
  const clauses: string[] = [];
  for (const c of columns) {
    const col = `t."${c.column_name.replace(/"/g, '""')}"`;
    if (SEARCH_TEXT_TYPES.has(c.data_type)) clauses.push(`${col} ILIKE $${paramIndex}`);
    else if (SEARCH_CAST_TYPES.has(c.data_type)) clauses.push(`${col}::text ILIKE $${paramIndex}`);
  }
  return clauses.length ? `WHERE (${clauses.join(' OR ')})` : 'WHERE FALSE';
}

/** A row without the editor's internal fields, for consumers outside the editor. */
export function withoutInternalFields<T extends Record<string, unknown> | undefined>(row: T): T {
  if (!row) return row;
  const copy = { ...row } as Record<string, unknown>;
  for (const k of INTERNAL_ROW_FIELDS) delete copy[k];
  return copy as T;
}

/** A constraint name derived from a table and column, kept within 63 bytes. */
function constraintName(table: string, column: string, suffix: string): string {
  const name = `${table}_${column}_${suffix}`;
  if (name.length <= MAX_IDENTIFIER_LENGTH) return name;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_IDENTIFIER_LENGTH - 9)}_${hash}`;
}

export interface ForeignKeyInfo {
  constraintName: string;
  columnName: string;
  foreignTableName: string;
  foreignColumnName: string;
}

@Injectable()
export class ProjectDataService {
  private readonly logger = new Logger(ProjectDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtimeData: RealtimeDataService,
  ) {}

  private async getProjectPool(
    projectId: string,
    userId?: string,
    opts?: { statementTimeoutMs?: number },
  ): Promise<{ pool: Pool; project: any }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (userId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!membership) throw new NotFoundException('Project not found');
    }

    const statementTimeoutMs =
      opts?.statementTimeoutMs !== undefined ? opts.statementTimeoutMs : 15_000;

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      ...(statementTimeoutMs > 0 ? { statement_timeout: statementTimeoutMs } : {}),
    });

    return { pool, project };
  }

  /**
   * Let a panel read see every row, including on tables that force policy on
   * their owner.
   *
   * A table with FORCE ROW LEVEL SECURITY applies its policies to the table
   * owner too, and the panel connects as exactly that owner. On a schema that
   * uses it, every count came back 0 and every grid came back empty while the
   * rows were all there — the owner could not see their own data anywhere in
   * the product, because the SQL editor and a direct connection use the same
   * role and are filtered the same way.
   *
   * service_role carries BYPASSRLS and the project's owner is a member of it,
   * so a read can borrow it for the length of one transaction. SET LOCAL
   * confines that to the transaction, and the caller is already a team member
   * proven by a dashboard session, so this grants no authority they did not
   * have — it shows them their own rows.
   *
   * Deliberately reads only. Writes stay as the owner: bypassing policy on a
   * write would also bypass every WITH CHECK the schema relies on, and would
   * change what current_user reports to the customer's own triggers.
   *
   * Returns whether the elevation took, so the answer can say so rather than
   * quietly showing rows a policy would have hidden. Projects whose database
   * predates service_role simply keep the old behaviour.
   */
  /**
   * Borrow service_role for the length of a read, so row-level security does
   * not hide rows from the dashboard.
   *
   * When `target` is given, the elevation is only kept if the borrowed role
   * can actually read that relation. An imported database may hold tables
   * service_role was never granted — Supabase keeps its own `auth` schema for
   * its internal admin role, and the project owner owns those tables while
   * service_role has nothing on them. Elevating regardless turned opening one
   * into "permission denied", which reached the dashboard as an internal
   * server error; and in the table list the refused COUNT aborted the
   * transaction, so every table after it silently fell back to an estimate.
   *
   * Dropping back to the session user is safe: it is the project's own owner,
   * which owns the imported tables and so is not bound by their policies
   * either, unless a table forces them.
   */
  private async elevateForRead(client: PoolClient, target?: string): Promise<boolean> {
    // Every step runs inside a savepoint. A statement that fails aborts the
    // whole transaction, and both of these can fail on an imported database:
    // the role may not exist, and resolving a table name needs USAGE on its
    // schema — asking about `supabase_migrations.schema_migrations` raises
    // "permission denied for schema" before the privilege is even considered.
    // Without the savepoint the enquiry would poison the read it was meant to
    // protect.
    await client.query('SAVEPOINT elevate_for_read');
    try {
      await client.query('SET LOCAL ROLE service_role');
    } catch (err: any) {
      await client.query('ROLLBACK TO SAVEPOINT elevate_for_read');
      this.logger.debug(
        `Reading as the project owner without elevation: ${err?.message ?? err}`,
      );
      return false;
    }

    if (!target) {
      await client.query('RELEASE SAVEPOINT elevate_for_read');
      return true;
    }

    let allowed = false;
    try {
      const { rows } = await client.query<{ allowed: boolean }>(
        `SELECT has_table_privilege(current_user, $1::regclass, 'SELECT') AS allowed`,
        [target],
      );
      allowed = rows[0]?.allowed === true;
      await client.query('RELEASE SAVEPOINT elevate_for_read');
    } catch {
      // Could not even resolve it as the borrowed role, which answers the
      // question: it cannot read it.
      await client.query('ROLLBACK TO SAVEPOINT elevate_for_read');
    }
    if (allowed) return true;

    await client.query('SET LOCAL ROLE NONE');
    return false;
  }

  async listTables(projectId: string, ownerId?: string): Promise<TableInfo[]> {
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      // A transaction so the read can borrow service_role for its length.
      // Without it, a schema that forces policy on the table owner counts
      // every table as empty — see elevateForRead.
      await client.query('BEGIN');
      await this.elevateForRead(client);

      // First pass: cheap n_live_tup read for every table. This populates the
      // sidebar instantly even on schemas with hundreds of tables.
      const result = await client.query(`
        SELECT
          t.tablename AS name,
          t.schemaname AS schema,
          COALESCE(s.n_live_tup, 0)::int AS "rowCount"
        FROM pg_catalog.pg_tables t
        LEFT JOIN pg_stat_user_tables s
          ON s.relname = t.tablename AND s.schemaname = t.schemaname
        WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.schemaname, t.tablename
      `);
      const rows = result.rows as TableInfo[];

      // Which of them the role doing the reading may actually count. One
      // query, and one that cannot fail: it passes each relation's oid rather
      // than a name, so nothing has to be resolved, and it asks about schema
      // USAGE first. Asking per table instead — with a name — raises
      // "permission denied for schema" on an imported database, and a failed
      // statement aborts the transaction, which cost every table after the
      // first unreadable one its real count.
      const readable = new Set<string>();
      const readableRows = await client.query<{ schema: string; name: string }>(`
        SELECT n.nspname AS schema, c.relname AS name
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND has_schema_privilege(current_user, n.nspname, 'USAGE')
           AND has_table_privilege(current_user, c.oid, 'SELECT')
      `);
      for (const r of readableRows.rows) readable.add(`${r.schema}.${r.name}`);

      // Second pass: refine with an exact COUNT(*) for small-to-medium
      // tables (<200k rows). n_live_tup is an autovacuum-maintained estimate
      // that lags real inserts, which made the sidebar disagree with the
      // header (header runs its own COUNT). Doing COUNT(*) on every table
      // would be expensive for million-row tables, so we cap it.
      //
      // Why 200k: a parallel seq scan on a million-row table takes ~100ms
      // typically; 200k tables resolve in tens of ms. With ~30 small tables
      // in a project the total overhead is well under 500ms and the sidebar
      // numbers match the header for everything that's reasonably sized.
      const COUNT_THRESHOLD = 200_000;
      const refinements = await Promise.all(
        rows.map(async (r) => {
          if (r.rowCount > COUNT_THRESHOLD) return r;
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.schema) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name)) {
            return r;
          }
          if (!readable.has(`${r.schema}.${r.name}`)) return r;
          try {
            const c = await client.query(
              `SELECT COUNT(*)::int AS total FROM "${r.schema}"."${r.name}"`,
            );
            return { ...r, rowCount: c.rows[0].total as number };
          } catch {
            // Anything else about this one table — keep the estimate rather
            // than losing the whole listing.
            return r;
          }
        }),
      );
      await client.query('COMMIT');
      return refinements;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
      await pool.end();
    }
  }

  async getColumns(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    schemaName?: string,
  ): Promise<ColumnInfo[]> {
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const schema = await this.resolveSchema(client, tableName, schemaName);
      const result = await client.query(
        `
        SELECT
          c.column_name AS name,
          c.data_type AS type,
          (c.is_nullable = 'YES') AS nullable,
          c.column_default AS "defaultValue",
          -- From pg_index rather than a join on the constraint views: a column
          -- that is in the primary key and also in a foreign key or unique
          -- constraint used to come back twice.
          EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
          ) AS "isPrimary",
          EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indrelid = a.attrelid AND i.indisunique AND NOT i.indisprimary
               AND i.indnatts = 1 AND i.indpred IS NULL AND i.indkey[0] = a.attnum
          ) AS "isUnique"
        FROM information_schema.columns c
        JOIN pg_attribute a
          ON a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
         AND a.attname = c.column_name
        WHERE c.table_name = $1
          AND c.table_schema = $2
        ORDER BY c.ordinal_position
        `,
        [tableName, schema],
      );
      return result.rows;
    } finally {
      client.release();
      await pool.end();
    }
  }

  async getRows(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    page = 1,
    limit = 50,
    schemaName?: string,
    search?: string,
    orderBy?: string,
    orderDir?: 'asc' | 'desc',
  ) {
    // Allow longer timeout for search queries on large tables
    const { pool, project } = await this.getProjectPool(projectId, ownerId, {
      statementTimeoutMs: search?.trim() ? 60_000 : 15_000,
    });
    // Cap the page size at the project's configured per-table row limit
    // (plan-gated). Never below 1 — a misconfigured 0 would break the grid.
    const cap = Math.max(1, (project as { maxRowsPerTable?: number }).maxRowsPerTable ?? 1000);
    page = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
    limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 50;
    if (limit > cap) limit = cap;
    const client = await pool.connect();
    const offset = (page - 1) * limit;

    try {
      // Wrap in explicit transaction so SET LOCAL takes effect
      await client.query('BEGIN');
      // Resolved before elevating: information_schema only shows a role the
      // relations it has privileges on, so a borrowed role can fail to find a
      // table the project owner can see perfectly well.
      const schema = await this.resolveSchema(client, tableName, schemaName);
      const qualified = `"${schema}"."${tableName}"`;
      const rlsBypassed = await this.elevateForRead(client, qualified);

      const trimmedSearch = (search ?? '').trim();
      // The filter input in the Table Editor used to slice the already-loaded
      // page client-side, which on a 1.5M-row table meant 99.99% of rows were
      // never even considered. Now we push the query to Postgres so it scans
      // the whole table — but smartly: an OR of ILIKEs over the columns that
      // can be read as text, built from the column list.
      let where = '';
      const params: any[] = [];
      if (trimmedSearch) {
        const colMeta = await client.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
          [schema, tableName],
        );
        params.push(`%${trimmedSearch}%`);
        where = searchWhereClause(colMeta.rows, params.length);
      }

      const fromClause = `FROM ${qualified} t`;

      // Counting filtered rows on a multi-million-row table is the part that
      // makes the user wait. For a search we count at most 10,000 matches and
      // flag the total as approximate; the grid pages on with `hasMore`
      // rather than stopping at the last "known" page.
      let total: number;
      let totalIsApprox: boolean;
      if (trimmedSearch) {
        const boundedCountSql = `SELECT COUNT(*)::int AS total FROM (SELECT 1 ${fromClause} ${where} LIMIT 10001) sub`;
        // Bump per-statement timeout for this query — searches are exploratory.
        await client.query(`SET LOCAL statement_timeout = '60s'`);
        const c = await client.query(boundedCountSql, params);
        const raw = c.rows[0].total as number;
        totalIsApprox = raw > 10000;
        total = totalIsApprox ? 10000 : raw;
      } else {
        const c = await client.query(`SELECT COUNT(*)::int AS total ${fromClause}`);
        total = c.rows[0].total as number;
        totalIsApprox = false;
      }

      // Order. Without an ORDER BY, LIMIT/OFFSET pages come from wherever a
      // (synchronized, possibly parallel) sequential scan happens to start, so
      // the same page returned different rows on every request and an edited
      // row jumped to the end. Pages are now ordered by the primary key — an
      // index scan, cheap at any size — and a column sort gets the key as a
      // tie-breaker. A table with no primary key is read in physical order
      // from its first block (sync scans and parallel workers off for this
      // transaction), which is stable for as long as the rows do not move,
      // without sorting the whole table on every page.
      const pkColumns = await this.primaryKeyColumns(client, schema, tableName);
      const quoted = (c: string) => `t."${c.replace(/"/g, '""')}"`;
      let order: string[] = [];
      let orderedBy: string[] = [];
      if (orderBy) {
        const colCheck = await client.query(
          `SELECT column_name FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
             LIMIT 1`,
          [schema, tableName, orderBy],
        );
        if (colCheck.rowCount && colCheck.rowCount > 0) {
          const dir = orderDir === 'desc' ? 'DESC' : 'ASC';
          // NULLS LAST keeps the same intent for both directions: real values
          // first, empties at the end. Postgres defaults differ per direction.
          const keyRest = pkColumns.filter((c) => c !== orderBy);
          order = [
            `${quoted(orderBy)} ${dir} NULLS LAST`,
            ...(pkColumns.length ? keyRest.map((c) => `${quoted(c)} ASC`) : ['t.ctid ASC']),
          ];
          orderedBy = [orderBy, ...keyRest];
        }
      }
      if (!order.length && pkColumns.length) {
        order = pkColumns.map((c) => `${quoted(c)} ASC`);
        orderedBy = pkColumns;
      }
      if (!order.length) {
        await client.query('SET LOCAL synchronize_seqscans = off');
        await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
      }
      const orderClause = order.length ? `ORDER BY ${order.join(', ')}` : '';

      // Raise timeout for filtered queries — ILIKE on 1M+ rows needs more than 15s
      if (trimmedSearch) {
        await client.query(`SET LOCAL statement_timeout = '60s'`);
      }

      const limitParamIdx = params.length + 1;
      const offsetParamIdx = params.length + 2;
      const dataResult = await client.query(
        // Carry the physical row id (edits on tables with no primary key) and
        // the row version (to notice a concurrent edit). Both stay out of
        // `fields`, so the grid never shows them. One extra row tells whether
        // another page exists when the total is only an estimate.
        `SELECT t.*, t.ctid::text AS "_bf_ctid", t.xmin::text AS "_bf_xmin" ${fromClause} ${where} ${orderClause} LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
        [...params, limit + 1, offset],
      );

      await client.query('COMMIT');

      const hasMore = dataResult.rows.length > limit;
      const rows = hasMore ? dataResult.rows.slice(0, limit) : dataResult.rows;
      return {
        rows,
        fields: dataResult.fields
          ?.filter((f) => !(INTERNAL_ROW_FIELDS as readonly string[]).includes(f.name))
          .map((f) => ({
            name: f.name,
            dataTypeId: f.dataTypeID,
          })),
        total,
        totalIsApprox,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        /** Another page follows (reliable even when `total` is approximate). */
        hasMore,
        /** The columns that order this page, for the grid to show. */
        orderedBy,
        // Reported rather than assumed, so the grid can say that what it
        // shows is not what a policy-bound caller would see.
        rlsBypassed,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw toUserFacingPgError(err, { prefix: 'Could not load rows' });
    } finally {
      client.release();
      await pool.end();
    }
  }

  /** Primary key columns of a table, in key order. */
  private async primaryKeyColumns(client: PoolClient, schema: string, table: string): Promise<string[]> {
    const r = await client.query<{ name: string }>(
      `SELECT a.attname AS name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = format('%I.%I', $1::text, $2::text)::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      [schema, table],
    );
    return r.rows.map((x) => x.name);
  }

  async createTable(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    columns: {
      name: string;
      type: string;
      nullable: boolean;
      isPrimary: boolean;
      defaultValue?: string;
      isUnique?: boolean;
    }[],
  ) {
    this.validateNewName(tableName, 'table');

    if (!Array.isArray(columns) || !columns.length) {
      throw new BadRequestException('At least one column is required');
    }

    const ALLOWED_TYPES = [
      'uuid', 'serial', 'bigserial',
      'integer', 'bigint', 'smallint',
      'text', 'varchar(255)', 'char(1)',
      'boolean',
      'timestamp', 'timestamptz', 'date', 'time',
      'numeric', 'decimal', 'real', 'double precision',
      'jsonb', 'json',
      'bytea',
    ];

    const primaryCols = columns.filter((c) => c.isPrimary);
    const seen = new Set<string>();

    const colDefs = columns.map((col) => {
      this.validateNewName(col.name, 'column');
      if (seen.has(col.name)) {
        throw new BadRequestException(`Column "${col.name}" appears more than once`);
      }
      seen.add(col.name);
      if (!ALLOWED_TYPES.includes(col.type)) {
        throw new BadRequestException(`Unsupported column type: ${col.type}`);
      }

      let def = `"${col.name}" ${col.type}`;
      if (!col.nullable) def += ' NOT NULL';
      if (col.defaultValue) {
        const safe = col.defaultValue.replace(/'/g, "''");
        if (['gen_random_uuid()', 'now()', 'true', 'false', 'CURRENT_TIMESTAMP'].includes(col.defaultValue)) {
          def += ` DEFAULT ${col.defaultValue}`;
        } else {
          def += ` DEFAULT '${safe}'`;
        }
      }
      // A primary key is unique already; a second constraint would only cost space.
      if (col.isUnique && !col.isPrimary) def += ' UNIQUE';
      return def;
    });

    if (primaryCols.length > 0) {
      const pkNames = primaryCols.map((c) => `"${c.name}"`).join(', ');
      colDefs.push(`PRIMARY KEY (${pkNames})`);
    }

    const sql = `CREATE TABLE "${tableName}" (\n  ${colDefs.join(',\n  ')}\n)`;

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      // Said in words before Postgres answers 'relation "x" already exists'.
      const taken = await client.query(
        `SELECT c.relkind FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relname = $1
          LIMIT 1`,
        [tableName],
      );
      if (taken.rowCount) {
        const kind = taken.rows[0].relkind === 'r' || taken.rows[0].relkind === 'p' ? 'A table' : 'Another object';
        throw new ConflictException(`${kind} named "${tableName}" already exists. Choose another name.`);
      }
      await client.query(sql);
      return { message: `Table "${tableName}" created`, sql, name: tableName };
    } catch (err: any) {
      throw this.dataError(err, 'Failed to create table');
    } finally {
      client.release();
      await pool.end();
    }
  }

  /**
   * Rename a table (and nothing else). Policies, indexes, foreign keys and
   * grants follow the table in Postgres; the REST path changes with the name.
   */
  async renameTable(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    newName: string,
    schemaName?: string,
  ) {
    this.validateTableName(tableName);
    this.validateNewName(newName, 'table');
    if (newName === tableName) return { message: 'Name unchanged', name: tableName };

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();
    try {
      const schema = await this.resolveSchema(client, tableName, schemaName);
      const taken = await client.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 LIMIT 1`,
        [schema, newName],
      );
      if (taken.rowCount) {
        throw new ConflictException(`A table or other object named "${newName}" already exists in "${schema}".`);
      }
      await client.query(`ALTER TABLE "${schema}"."${tableName}" RENAME TO "${newName}"`);
      return { message: `Table "${tableName}" renamed to "${newName}"`, name: newName, schema };
    } catch (err: any) {
      throw this.dataError(err, 'Failed to rename table');
    } finally {
      client.release();
      await pool.end();
    }
  }

  async dropTable(projectId: string, ownerId: string | undefined, tableName: string) {
    this.validateTableName(tableName);

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
      return { message: `Table "${tableName}" dropped` };
    } catch (err: any) {
      throw toUserFacingPgError(err, { prefix: 'Failed to drop table' });
    } finally {
      client.release();
      await pool.end();
    }
  }

  async insertRow(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    data: Record<string, unknown>,
    schemaName?: string,
  ) {
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const schema = await this.resolveSchema(client, tableName, schemaName);
      const qualified = `"${schema}"."${tableName}"`;
      const keys = Object.keys(data ?? {}).filter(
        (k) =>
          data[k] !== undefined &&
          data[k] !== '' &&
          !(INTERNAL_ROW_FIELDS as readonly string[]).includes(k),
      );
      for (const k of keys) this.validateColumnName(k);

      const values = keys.map((k) => (data[k] === null || data[k] === 'NULL' ? null : data[k]));

      await client.query('SET LOCAL row_security = off');
      // Nothing filled in is a row of defaults, which is a valid insert; a
      // required column without a default then says which one it is.
      const insert = keys.length
        ? `INSERT INTO ${qualified} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`
        : `INSERT INTO ${qualified} DEFAULT VALUES`;
      const result = await client.query(
        `${insert} RETURNING *, ctid::text AS "_bf_ctid", xmin::text AS "_bf_xmin"`,
        values,
      );
      this.realtimeData.publishChange(projectId, {
        type: 'INSERT', kind: 'table', entity: tableName, new: withoutInternalFields(result.rows[0]),
      });
      return result.rows[0];
    } catch (err: any) {
      throw this.dataError(err, 'Insert failed');
    } finally {
      client.release();
      await pool.end();
    }
  }

  /**
   * Update one row. `expectedVersion` is the row's xmin as the editor read it
   * (`_bf_xmin`): when given, the update only applies if nobody changed the
   * row since — otherwise 409 ROW_CHANGED, and the caller decides whether to
   * reload or overwrite. Without it the update behaves as it always did.
   */
  async updateRow(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    pkWhere: Record<string, unknown>,
    data: Record<string, unknown>,
    schemaName?: string,
    expectedVersion?: string,
  ) {
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const schema = await this.resolveSchema(client, tableName, schemaName);
      const qualified = `"${schema}"."${tableName}"`;
      const setCols = Object.keys(data ?? {}).filter(
        (k) => !(INTERNAL_ROW_FIELDS as readonly string[]).includes(k),
      );
      if (!setCols.length) throw new BadRequestException('No data to update');
      for (const k of setCols) this.validateColumnName(k);

      let paramIdx = 1;
      const setClause = setCols
        .map((k) => `"${k}" = $${paramIdx++}`)
        .join(', ');
      const setValues = setCols.map((k) => (data[k] === null || data[k] === 'NULL' ? null : data[k]));

      let whereClause: string;
      let whereValues: unknown[];
      const byCtid = pkWhere?._bf_ctid != null;
      if (byCtid) {
        // Physical-row-id update — works on tables with no primary key.
        whereClause = `ctid = $${paramIdx++}::tid`;
        whereValues = [pkWhere._bf_ctid];
      } else {
        const whereCols = Object.keys(pkWhere ?? {}).filter(
          (k) => !(INTERNAL_ROW_FIELDS as readonly string[]).includes(k),
        );
        if (!whereCols.length) throw new BadRequestException('No primary key provided');
        for (const k of whereCols) this.validateColumnName(k);
        whereClause = whereCols.map((k) => `"${k}" IS NOT DISTINCT FROM $${paramIdx++}`).join(' AND ');
        whereValues = whereCols.map((k) => pkWhere[k]);
      }
      const versionClause =
        typeof expectedVersion === 'string' && /^\d+$/.test(expectedVersion)
          ? ` AND xmin::text = $${paramIdx++}`
          : '';
      const versionValues = versionClause ? [expectedVersion] : [];

      await client.query('SET LOCAL row_security = off');
      const result = await client.query(
        `UPDATE ${qualified} SET ${setClause} WHERE ${whereClause}${versionClause} RETURNING *, ctid::text AS "_bf_ctid", xmin::text AS "_bf_xmin"`,
        [...setValues, ...whereValues, ...versionValues],
      );

      if (result.rowCount === 0) {
        if (versionClause && !byCtid) {
          // Tell "someone else changed it" apart from "it is gone".
          const offset = setValues.length;
          const stillThere = await client.query(
            `SELECT 1 FROM ${qualified} WHERE ${whereClause.replace(/\$(\d+)/g, (_, n) => `$${Number(n) - offset}`)} LIMIT 1`,
            whereValues,
          );
          if (stillThere.rowCount) {
            throw new ConflictException({
              code: ROW_CHANGED_CODE,
              message:
                'Someone else changed this row after you opened it. Reload to see the current values, or save again to overwrite them.',
            });
          }
        }
        throw new NotFoundException(
          byCtid
            ? 'Row not found — it was changed or deleted after you loaded it. Reload to see the current data.'
            : 'Row not found — it may have been deleted. Reload to see the current data.',
        );
      }
      this.realtimeData.publishChange(projectId, {
        type: 'UPDATE', kind: 'table', entity: tableName, new: withoutInternalFields(result.rows[0]), old: pkWhere,
      });
      return result.rows[0];
    } catch (err: any) {
      throw this.dataError(err, 'Update failed');
    } finally {
      client.release();
      await pool.end();
    }
  }

  /**
   * The error a row or table write answers with. Postgres errors keep their
   * words and get a 4xx; a missing required value names its column. Anything
   * else is wrapped as before (400 with the action in front).
   */
  private dataError(err: any, action: string): unknown {
    if (err instanceof HttpException) return err;
    if (isPgError(err) && err.code === '23502' && (err as { column?: string }).column) {
      return new BadRequestException(
        `${action}: "${(err as { column?: string }).column}" is required — enter a value for it.`,
      );
    }
    const mapped = toUserFacingPgError(err, { prefix: action });
    if (mapped instanceof HttpException) return mapped;
    return new BadRequestException(`${action}: ${err?.message ?? err}`);
  }

  async deleteRow(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    pkWhere: Record<string, unknown>,
    schemaName?: string,
  ) {
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const schema = await this.resolveSchema(client, tableName, schemaName);
      const qualified = `"${schema}"."${tableName}"`;

      // Dashboard is an admin surface — bypass RLS so deletes always work
      // even when the table has no DELETE policy for the project DB role.
      await client.query('SET LOCAL row_security = off');

      let result;
      if (pkWhere._bf_ctid != null) {
        // Physical-row-id delete — exact, works on any primary-key-less table.
        result = await client.query(
          `DELETE FROM ${qualified} WHERE ctid = $1::tid`,
          [pkWhere._bf_ctid],
        );
      } else {
        const whereCols = Object.keys(pkWhere);
        if (!whereCols.length) throw new BadRequestException('No row identifier provided');
        for (const k of whereCols) this.validateColumnName(k);

        // IS NOT DISTINCT FROM is null-safe (matches NULL = NULL), so tables
        // without a primary key can be matched on their full column set.
        const whereClause = whereCols
          .map((k, i) => `"${k}" IS NOT DISTINCT FROM $${i + 1}`)
          .join(' AND ');
        const values = whereCols.map((k) => pkWhere[k]);

        // Delete exactly one matching row via ctid.
        result = await client.query(
          `DELETE FROM ${qualified} WHERE ctid = (SELECT ctid FROM ${qualified} WHERE ${whereClause} LIMIT 1)`,
          values,
        );
      }

      if (result.rowCount === 0) {
        throw new NotFoundException('Row not found — it may already have been deleted. Reload to see the current data.');
      }
      this.realtimeData.publishChange(projectId, {
        type: 'DELETE', kind: 'table', entity: tableName, old: pkWhere,
      });
      return { message: 'Row deleted' };
    } catch (err: any) {
      // e.g. another table still references the row (foreign key) — a 4xx
      // with Postgres' own explanation instead of a bare 500.
      throw this.dataError(err, 'Delete failed');
    } finally {
      client.release();
      await pool.end();
    }
  }

  /**
   * Removes duplicate rows by a user-chosen key (same values on all key columns
   * = duplicate). Uses ctid so a primary key is not required. Keeps one row per
   * duplicate group (the one with the lexicographically largest ctid).
   */
  async deduplicateTableRows(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    keyColumns: string[],
    schemaName: string | undefined,
    previewOnly: boolean,
  ): Promise<{
    preview: boolean;
    rowsToDelete?: number;
    previewCapped?: boolean;
    deleted?: number;
    partial?: boolean;
    batchesRun?: number;
  }> {
    if (!Array.isArray(keyColumns) || keyColumns.length === 0) {
      throw new BadRequestException('Provide at least one key column');
    }
    if (keyColumns.length > 24) {
      throw new BadRequestException('At most 24 key columns');
    }
    if (new Set(keyColumns).size !== keyColumns.length) {
      throw new BadRequestException('Duplicate column names in key set');
    }
    for (const c of keyColumns) {
      this.validateColumnName(c);
    }
    this.validateTableName(tableName);

    /** No driver-level cap; per-statement limit disabled on the session below. */
    const { pool } = await this.getProjectPool(projectId, ownerId, {
      statementTimeoutMs: 0,
    });
    const client = await pool.connect();

    const PREVIEW_CAP = 100_000;
    const BATCH_SIZE = 8_000;
    const MAX_BATCHES_PER_REQUEST = 2_000;

    try {
      // Disable the per-statement timeout entirely for this connection — dedup
      // on million-row tables can run for minutes when there's no supporting
      // index. The connection is dedicated to this request and the pool is
      // closed below, so this can't leak to other queries.
      await client.query(`SET statement_timeout = 0`);

      const schema = await this.resolveSchema(client, tableName, schemaName);
      const qualified = `"${schema}"."${tableName}"`;

      // Build the key-equality predicate. PARTITION BY uses normal equality
      // (NULLs are treated as equal in PARTITION semantics, which matches our
      // documented "NULL values match each other" behaviour).
      const partitionCols = keyColumns.map((k) => `"${k}"`).join(', ');

      if (previewOnly) {
        // How many rows would the dedup delete? Use ROW_NUMBER() over the
        // partitioning keys — every row with rn > 1 is a duplicate of an
        // earlier row in its group. This is a single scan, way cheaper than
        // the self-join EXISTS approach we had before (O(n) vs O(n²)).
        const countSql = `
          SELECT COUNT(*)::bigint AS c FROM (
            SELECT 1 FROM (
              SELECT ROW_NUMBER() OVER (PARTITION BY ${partitionCols} ORDER BY ctid) AS rn
              FROM ${qualified}
            ) ranked
            WHERE rn > 1
            LIMIT ${PREVIEW_CAP + 1}
          ) sub
        `;
        const r = await client.query(countSql);
        const c = Number(r.rows[0]?.c ?? 0);
        const previewCapped = c > PREVIEW_CAP;
        return { preview: true, rowsToDelete: c, previewCapped };
      }

      // Batched delete: same window-function trick, but materialise the next
      // BATCH_SIZE duplicate ctids and delete them in one round. Looping until
      // a batch returns 0 rows means we converge naturally.
      const deleteBatchSql = `
        DELETE FROM ${qualified}
        WHERE ctid IN (
          SELECT ctid FROM (
            SELECT ctid, ROW_NUMBER() OVER (PARTITION BY ${partitionCols} ORDER BY ctid) AS rn
            FROM ${qualified}
          ) ranked
          WHERE rn > 1
          LIMIT ${BATCH_SIZE}
        )
      `;

      let totalDeleted = 0;
      let batches = 0;
      let lastN = 0;

      while (batches < MAX_BATCHES_PER_REQUEST) {
        const result = await client.query(deleteBatchSql);
        lastN = result.rowCount ?? 0;
        totalDeleted += lastN;
        batches += 1;
        if (lastN === 0) {
          break;
        }
      }

      let partial = false;
      if (lastN > 0 && batches >= MAX_BATCHES_PER_REQUEST) {
        const peek = await client.query(deleteBatchSql);
        const extra = peek.rowCount ?? 0;
        totalDeleted += extra;
        partial = extra > 0;
        if (extra > 0) {
          batches += 1;
        }
      }

      return {
        preview: false,
        deleted: totalDeleted,
        partial,
        batchesRun: batches,
      };
    } catch (err: any) {
      if (err instanceof BadRequestException || err instanceof NotFoundException) {
        throw err;
      }
      throw new BadRequestException(`Deduplicate failed: ${err.message}`);
    } finally {
      try {
        await client.query('RESET statement_timeout');
      } catch {
        // ignore
      }
      client.release();
      await pool.end();
    }
  }

  /**
   * Resolves the schema a table lives in. Required because listTables() surfaces
   * tables across every non-system schema (public, auth, …) but the row/column
   * endpoints used to issue unqualified `"<table>"` queries that only resolve
   * against the connection's search_path. The Table Editor would then list a
   * table successfully and 500 with `relation does not exist` on click.
   *
   * If `schemaName` is provided, validates and returns it (after confirming the
   * table exists there). Otherwise, looks up pg_tables for the unique schema
   * containing this table — throws if zero or multiple matches.
   */
  private async resolveSchema(
    client: import('pg').PoolClient,
    tableName: string,
    schemaName?: string,
  ): Promise<string> {
    this.validateTableName(tableName);

    if (schemaName !== undefined && schemaName !== null && schemaName !== '') {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
        throw new BadRequestException('Invalid schema name');
      }
      if (['pg_catalog', 'information_schema'].includes(schemaName)) {
        throw new BadRequestException('System schemas are not addressable');
      }
      const exists = await client.query(
        `SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = $2`,
        [schemaName, tableName],
      );
      if (exists.rowCount === 0) {
        throw new NotFoundException(`Table "${schemaName}"."${tableName}" not found`);
      }
      return schemaName;
    }

    const lookup = await client.query(
      `SELECT schemaname FROM pg_catalog.pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         AND tablename = $1`,
      [tableName],
    );
    if (lookup.rowCount === 0) {
      throw new NotFoundException(`Table "${tableName}" not found`);
    }
    if ((lookup.rowCount ?? 0) > 1) {
      const schemas = lookup.rows.map((r) => r.schemaname).join(', ');
      throw new BadRequestException(
        `Table "${tableName}" exists in multiple schemas (${schemas}). ` +
          `Pass ?schema= to disambiguate.`,
      );
    }
    return lookup.rows[0].schemaname;
  }

  private validateTableName(name: string) {
    if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new BadRequestException("Invalid table name");
    }
    if (name.length > MAX_IDENTIFIER_LENGTH) {
      throw new BadRequestException(`Table name is too long (${name.length} characters; at most ${MAX_IDENTIFIER_LENGTH})`);
    }
  }

  private validateColumnName(name: string) {
    if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new BadRequestException(`Invalid column name: ${name}`);
    }
    if (name.length > MAX_IDENTIFIER_LENGTH) {
      throw new BadRequestException(`Column name is too long (${name.length} characters; at most ${MAX_IDENTIFIER_LENGTH})`);
    }
  }

  /**
   * A name about to be created. Same rules as above, said for someone typing
   * it: Postgres would otherwise cut a long name at 63 characters without a
   * word, and the dashboard would go on looking for the full one.
   */
  private validateNewName(name: string, what: "table" | "column") {
    const label = what === "table" ? "Table" : "Column";
    if (typeof name !== "string" || !name.trim()) {
      throw new BadRequestException(`${label} name is required`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new BadRequestException(
        `${label} name "${name}" is not valid: use letters, digits and underscores, starting with a letter or underscore`,
      );
    }
    if (name.length > MAX_IDENTIFIER_LENGTH) {
      throw new BadRequestException(
        `${label} name is ${name.length} characters long; PostgreSQL allows at most ${MAX_IDENTIFIER_LENGTH}`,
      );
    }
  }

  private validateColumnType(type: string) {
    const ALLOWED_TYPES = [
      'uuid', 'serial', 'bigserial',
      'integer', 'bigint', 'smallint',
      'text', 'varchar(255)', 'char(1)',
      'boolean',
      'timestamp', 'timestamptz', 'date', 'time',
      'numeric', 'decimal', 'real', 'double precision',
      'jsonb', 'json',
      'bytea',
    ];
    if (!ALLOWED_TYPES.includes(type)) {
      throw new BadRequestException(`Unsupported column type: ${type}`);
    }
  }

  async addColumn(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    column: { name: string; type: string; nullable: boolean; defaultValue?: string; isUnique?: boolean },
  ) {
    this.validateTableName(tableName);
    this.validateNewName(column.name, 'column');
    this.validateColumnType(column.type);

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      let sql = `ALTER TABLE "${tableName}" ADD COLUMN "${column.name}" ${column.type}`;
      if (!column.nullable) sql += ' NOT NULL';
      if (column.defaultValue) {
        const SAFE_DEFAULTS = ['gen_random_uuid()', 'now()', 'true', 'false', 'CURRENT_TIMESTAMP'];
        if (SAFE_DEFAULTS.includes(column.defaultValue)) {
          sql += ` DEFAULT ${column.defaultValue}`;
        } else {
          const safe = column.defaultValue.replace(/'/g, "''");
          sql += ` DEFAULT '${safe}'`;
        }
      }
      if (column.isUnique) sql += ' UNIQUE';

      await client.query(sql);
      return { message: `Column "${column.name}" added to "${tableName}"` };
    } catch (err: any) {
      throw this.dataError(err, 'Failed to add column');
    } finally {
      client.release();
      await pool.end();
    }
  }

  async editColumn(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    columnName: string,
    changes: { name?: string; type?: string; nullable?: boolean; defaultValue?: string | null; isUnique?: boolean },
  ) {
    this.validateTableName(tableName);
    this.validateColumnName(columnName);
    if (changes.name) this.validateNewName(changes.name, 'column');
    if (changes.type) this.validateColumnType(changes.type);

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const statements: string[] = [];

      // UNIQUE on or off. Done before a rename, under the current name.
      if (changes.isUnique !== undefined) {
        const existing = await client.query<{ conname: string }>(
          `SELECT con.conname
             FROM pg_constraint con
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
            WHERE con.conrelid = format('%I', $1::text)::regclass
              AND con.contype = 'u' AND array_length(con.conkey, 1) = 1
              AND a.attname = $2`,
          [tableName, columnName],
        );
        if (changes.isUnique && existing.rowCount === 0) {
          const name = constraintName(tableName, columnName, 'key');
          statements.push(`ALTER TABLE "${tableName}" ADD CONSTRAINT "${name}" UNIQUE ("${columnName}")`);
        } else if (changes.isUnique === false) {
          if (existing.rowCount === 0) {
            const index = await client.query<{ relname: string }>(
              `SELECT ic.relname FROM pg_index i
                 JOIN pg_class ic ON ic.oid = i.indexrelid
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                WHERE i.indrelid = format('%I', $1::text)::regclass
                  AND i.indisunique AND NOT i.indisprimary AND i.indnatts = 1 AND a.attname = $2
                LIMIT 1`,
              [tableName, columnName],
            );
            if (index.rowCount) {
              throw new BadRequestException(
                `"${columnName}" is unique because of the index "${index.rows[0].relname}". Drop that index on the Database page to allow duplicates.`,
              );
            }
          }
          for (const row of existing.rows) {
            statements.push(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${row.conname.replace(/"/g, '""')}"`);
          }
        }
      }

      if (changes.type) {
        statements.push(
          `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" TYPE ${changes.type} USING "${columnName}"::${changes.type}`,
        );
      }

      if (changes.nullable === true) {
        statements.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" DROP NOT NULL`);
      } else if (changes.nullable === false) {
        statements.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" SET NOT NULL`);
      }

      if (changes.defaultValue !== undefined) {
        if (changes.defaultValue === null || changes.defaultValue === '') {
          statements.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" DROP DEFAULT`);
        } else {
          const SAFE_DEFAULTS = ['gen_random_uuid()', 'now()', 'true', 'false', 'CURRENT_TIMESTAMP'];
          const defaultExpr = SAFE_DEFAULTS.includes(changes.defaultValue)
            ? changes.defaultValue
            : `'${changes.defaultValue.replace(/'/g, "''")}'`;
          statements.push(
            `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" SET DEFAULT ${defaultExpr}`,
          );
        }
      }

      if (changes.name && changes.name !== columnName) {
        statements.push(
          `ALTER TABLE "${tableName}" RENAME COLUMN "${columnName}" TO "${changes.name}"`,
        );
      }

      // All or nothing: a type change that fails must not leave the column
      // renamed or its default dropped.
      await client.query('BEGIN');
      try {
        for (const sql of statements) {
          await client.query(sql);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }

      const renamed = changes.name && changes.name !== columnName ? changes.name : null;
      return {
        message: renamed
          ? `Column "${columnName}" renamed to "${renamed}"`
          : `Column "${columnName}" updated`,
        name: renamed ?? columnName,
      };
    } catch (err: any) {
      throw this.dataError(err, 'Failed to edit column');
    } finally {
      client.release();
      await pool.end();
    }
  }

  async deleteColumn(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    columnName: string,
  ) {
    this.validateTableName(tableName);
    this.validateColumnName(columnName);

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      await client.query(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}" CASCADE`);
      return { message: `Column "${columnName}" deleted from "${tableName}"` };
    } catch (err: any) {
      throw this.dataError(err, "Failed to delete column");
    } finally {
      client.release();
      await pool.end();
    }
  }

  async getForeignKeys(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
  ): Promise<ForeignKeyInfo[]> {
    this.validateTableName(tableName);
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const result = await client.query(
        `
        SELECT
          tc.constraint_name AS "constraintName",
          kcu.column_name AS "columnName",
          ccu.table_name AS "foreignTableName",
          ccu.column_name AS "foreignColumnName"
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = $1
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY kcu.ordinal_position
        `,
        [tableName],
      );
      return result.rows;
    } finally {
      client.release();
      await pool.end();
    }
  }

  async addForeignKey(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    body: { columnName: string; foreignTableName: string; foreignColumnName: string },
  ) {
    this.validateTableName(tableName);
    this.validateColumnName(body.columnName);
    this.validateTableName(body.foreignTableName);
    this.validateColumnName(body.foreignColumnName);

    const constraintName = `fk_${tableName}_${body.columnName}_${body.foreignTableName}`.slice(0, 63);
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      await client.query(
        `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" ` +
          `FOREIGN KEY ("${body.columnName}") REFERENCES "${body.foreignTableName}" ("${body.foreignColumnName}")`,
      );
      return { message: 'Foreign key added' };
    } catch (err: any) {
      throw this.dataError(err, "Failed to add foreign key");
    } finally {
      client.release();
      await pool.end();
    }
  }

  async deleteForeignKey(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    constraintName: string,
  ) {
    this.validateTableName(tableName);
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      await client.query(
        `ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName.replace(/"/g, '""')}"`,
      );
      return { message: `Foreign key "${constraintName}" dropped` };
    } catch (err: any) {
      throw this.dataError(err, "Failed to remove foreign key");
    } finally {
      client.release();
      await pool.end();
    }
  }

  getConnectionStrings(project: any) {
    const internalHost = project.dbHost;
    const internalPort = project.dbPort;
    const db = project.dbName;
    const user = project.dbUser;
    const password = project.dbPassword;
    const publicApiUrl = this.config.get<string>('publicApiUrl') || 'http://localhost:4000';
    const publicBaseUrl = publicApiUrl.replace(/\/+$/, '');

    // External PgBouncer endpoint — what users connect to from pgAdmin, DBeaver, etc.
    const { host: extPoolerHost, port: extPoolerPort } = getPgbouncerClientEndpoints(this.config);

    const { host: directHost, port: directPort } = getPostgresDirectClientEndpoints(
      this.config,
      extPoolerHost,
      extPoolerPort,
    );

    return {
      uri: buildPostgresUri(directHost, directPort, user, password, db),
      poolerUri: buildPostgresUri(extPoolerHost, extPoolerPort, user, password, db),
      host: extPoolerHost,
      port: directPort,
      database: db,
      user,
      password,
      poolerHost: extPoolerHost,
      poolerPort: extPoolerPort,
      restUrl: `${publicApiUrl}/api/rest/v1`,
      publicBaseUrl,
      keycloakRealm: project.keycloakRealm,
      keycloakUrl: this.config.get('keycloak.publicUrl') || this.config.get('keycloak.url'),
      anonKey: project.anonKey,
      serviceKey: project.serviceKey,
      // SELECT-only companion role; null until the team creates it.
      readonly:
        project.dbReadonlyUser && project.dbReadonlyPassword
          ? {
              user: project.dbReadonlyUser as string,
              password: project.dbReadonlyPassword as string,
              uri: buildPostgresUri(directHost, directPort, project.dbReadonlyUser, project.dbReadonlyPassword, db),
              poolerUri: buildPostgresUri(extPoolerHost, extPoolerPort, project.dbReadonlyUser, project.dbReadonlyPassword, db),
            }
          : null,
    };
  }
}
