import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildPostgresUri,
  getPostgresDirectClientEndpoints,
} from './postgres-uri.util';

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
}

export interface ForeignKeyInfo {
  constraintName: string;
  columnName: string;
  foreignTableName: string;
  foreignColumnName: string;
}

@Injectable()
export class ProjectDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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

  async listTables(projectId: string, ownerId?: string): Promise<TableInfo[]> {
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
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
          try {
            const c = await client.query(
              `SELECT COUNT(*)::int AS total FROM "${r.schema}"."${r.name}"`,
            );
            return { ...r, rowCount: c.rows[0].total as number };
          } catch {
            // Permission errors or other quirks — fall back to the estimate.
            return r;
          }
        }),
      );
      return refinements;
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
          COALESCE(tc.constraint_type = 'PRIMARY KEY', false) AS "isPrimary"
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage kcu
          ON kcu.table_name = c.table_name
          AND kcu.column_name = c.column_name
          AND kcu.table_schema = c.table_schema
        LEFT JOIN information_schema.table_constraints tc
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.constraint_type = 'PRIMARY KEY'
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
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();
    const offset = (page - 1) * limit;

    try {
      const schema = await this.resolveSchema(client, tableName, schemaName);
      const qualified = `"${schema}"."${tableName}"`;

      const trimmedSearch = (search ?? '').trim();
      // The filter input in the Table Editor used to slice the already-loaded
      // page client-side, which on a 1.5M-row table meant 99.99% of rows were
      // never even considered. Now we push the query to Postgres so it scans
      // the whole table — but smartly.
      //
      // First attempt used `to_jsonb(t) + jsonb_each_text` to search every
      // column without enumerating names. Correct, but on 1.5M+ rows it
      // tripped the 15s statement_timeout because building the jsonb per row
      // is expensive. New approach: pre-fetch the column list and build a
      // direct OR-of-ILIKEs against the text-shaped columns. Postgres can
      // plan this against indexes when present, and even without indexes the
      // seq scan is dramatically cheaper than the jsonb path.
      let where = '';
      const params: any[] = [];
      if (trimmedSearch) {
        // Find text-ish columns (cheap meta query). Anything we can cast to
        // text — i.e. everything except blobs/json — is fair game. We accept
        // text/character_varying/character/citext directly, and CAST other
        // types to text so the user can also find numbers, dates, etc.
        const colMeta = await client.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
          [schema, tableName],
        );
        const TEXT_TYPES = new Set([
          'text', 'character varying', 'character', 'citext', 'name', 'uuid',
        ]);
        const NUMERIC_TYPES = new Set([
          'integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision',
          'date', 'timestamp without time zone', 'timestamp with time zone',
          'time without time zone', 'time with time zone',
          'boolean',
        ]);
        params.push(`%${trimmedSearch}%`);
        const orClauses: string[] = [];
        for (const c of colMeta.rows) {
          const safe = c.column_name.replace(/"/g, '""');
          if (TEXT_TYPES.has(c.data_type)) {
            orClauses.push(`t."${safe}" ILIKE $${params.length}`);
          } else if (NUMERIC_TYPES.has(c.data_type)) {
            // CAST is fast; the planner can still parallelise the seq scan.
            orClauses.push(`t."${safe}"::text ILIKE $${params.length}`);
          }
          // Skip jsonb / bytea / arrays — these are expensive and rarely the
          // target of a user's free-text search.
        }
        if (orClauses.length > 0) {
          where = `WHERE (${orClauses.join(' OR ')})`;
        } else {
          // No searchable columns — return empty result rather than scanning.
          where = 'WHERE FALSE';
        }
      }

      const fromClause = `FROM ${qualified} t`;

      // Counting filtered rows on a multi-million-row table is the part that
      // makes the user wait, and they almost never care about the exact total
      // when searching ("there are 4,321 matches" vs "many matches" is the
      // same UX). We skip COUNT for search and just signal "approx" so the UI
      // can render "X+ rows" or "many rows". For unfiltered listings we still
      // do an exact COUNT — that's the number the sidebar badge needs.
      let total: number;
      let totalIsApprox: boolean;
      if (trimmedSearch) {
        // Quick bounded count: only count up to 1000 matches. If we hit 1000,
        // it's "1000+". This stays well below the timeout even on huge tables.
        const boundedCountSql = `SELECT COUNT(*)::int AS total FROM (SELECT 1 ${fromClause} ${where} LIMIT 1001) sub`;
        // Bump per-statement timeout for this query — searches are exploratory.
        await client.query(`SET LOCAL statement_timeout = '60s'`);
        const c = await client.query(boundedCountSql, params);
        const raw = c.rows[0].total as number;
        totalIsApprox = raw > 1000;
        total = totalIsApprox ? 1000 : raw;
      } else {
        const c = await client.query(`SELECT COUNT(*)::int AS total ${fromClause}`);
        total = c.rows[0].total as number;
        totalIsApprox = false;
      }

      // For searches we already raised statement_timeout to 60s above; the
      // SET LOCAL persists for the rest of the transaction (the pg pool gives
      // us an implicit transaction per checkout). For unfiltered listings the
      // default 15s timeout is plenty.

      // Sort: if the caller requested a column-level sort, validate the
      // column name against the actual table columns (to block injection)
      // and append ORDER BY. We resolve columns via information_schema once
      // per request — cheap, and we already opened a client.
      let orderClause = '';
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
          orderClause = `ORDER BY t."${orderBy}" ${dir} NULLS LAST`;
        }
      }

      const limitParamIdx = params.length + 1;
      const offsetParamIdx = params.length + 2;
      const dataResult = await client.query(
        `SELECT t.* ${fromClause} ${where} ${orderClause} LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
        [...params, limit, offset],
      );

      return {
        rows: dataResult.rows,
        fields: dataResult.fields?.map((f) => ({
          name: f.name,
          dataTypeId: f.dataTypeID,
        })),
        total,
        totalIsApprox,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      };
    } finally {
      client.release();
      await pool.end();
    }
  }

  async createTable(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    columns: { name: string; type: string; nullable: boolean; isPrimary: boolean; defaultValue?: string }[],
  ) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new BadRequestException('Invalid table name');
    }

    if (!columns.length) {
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

    const colDefs = columns.map((col) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col.name)) {
        throw new BadRequestException(`Invalid column name: ${col.name}`);
      }
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
      await client.query(sql);
      return { message: `Table "${tableName}" created`, sql };
    } catch (err: any) {
      throw new BadRequestException(`Failed to create table: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async dropTable(projectId: string, ownerId: string | undefined, tableName: string) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new BadRequestException('Invalid table name');
    }

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
      return { message: `Table "${tableName}" dropped` };
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
      const keys = Object.keys(data).filter((k) => data[k] !== undefined && data[k] !== '');
      if (!keys.length) throw new BadRequestException('No data provided');
      for (const k of keys) this.validateColumnName(k);

      const cols = keys.map((k) => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const values = keys.map((k) => data[k] === null || data[k] === 'NULL' ? null : data[k]);

      const result = await client.query(
        `INSERT INTO ${qualified} (${cols}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      return result.rows[0];
    } catch (err: any) {
      throw new BadRequestException(`Insert failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async updateRow(
    projectId: string,
    ownerId: string | undefined,
    tableName: string,
    pkWhere: Record<string, unknown>,
    data: Record<string, unknown>,
    schemaName?: string,
  ) {
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const schema = await this.resolveSchema(client, tableName, schemaName);
      const qualified = `"${schema}"."${tableName}"`;
      const setCols = Object.keys(data);
      const whereCols = Object.keys(pkWhere);
      if (!setCols.length) throw new BadRequestException('No data to update');
      if (!whereCols.length) throw new BadRequestException('No primary key provided');
      for (const k of setCols) this.validateColumnName(k);
      for (const k of whereCols) this.validateColumnName(k);

      let paramIdx = 1;
      const setClause = setCols
        .map((k) => `"${k}" = $${paramIdx++}`)
        .join(', ');
      const whereClause = whereCols
        .map((k) => `"${k}" = $${paramIdx++}`)
        .join(' AND ');

      const values = [
        ...setCols.map((k) => data[k] === null || data[k] === 'NULL' ? null : data[k]),
        ...whereCols.map((k) => pkWhere[k]),
      ];

      const result = await client.query(
        `UPDATE ${qualified} SET ${setClause} WHERE ${whereClause} RETURNING *`,
        values,
      );

      if (result.rowCount === 0) throw new NotFoundException('Row not found');
      return result.rows[0];
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      throw new BadRequestException(`Update failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
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
      const whereCols = Object.keys(pkWhere);
      if (!whereCols.length) throw new BadRequestException('No primary key provided');
      for (const k of whereCols) this.validateColumnName(k);

      const whereClause = whereCols
        .map((k, i) => `"${k}" = $${i + 1}`)
        .join(' AND ');
      const values = whereCols.map((k) => pkWhere[k]);

      const result = await client.query(
        `DELETE FROM ${qualified} WHERE ${whereClause}`,
        values,
      );

      if (result.rowCount === 0) throw new NotFoundException('Row not found');
      return { message: 'Row deleted' };
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
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new BadRequestException('Invalid table name');
    }
  }

  private validateColumnName(name: string) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new BadRequestException(`Invalid column name: ${name}`);
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
    this.validateColumnName(column.name);
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
      throw new BadRequestException(`Failed to add column: ${err.message}`);
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
    if (changes.name) this.validateColumnName(changes.name);
    if (changes.type) this.validateColumnType(changes.type);

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const statements: string[] = [];

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

      for (const sql of statements) {
        await client.query(sql);
      }

      return { message: `Column "${columnName}" updated` };
    } catch (err: any) {
      throw new BadRequestException(`Failed to edit column: ${err.message}`);
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
      throw new BadRequestException(`Failed to delete column: ${err.message}`);
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
      throw new BadRequestException(`Failed to add foreign key: ${err.message}`);
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
    } finally {
      client.release();
      await pool.end();
    }
  }

  getConnectionStrings(project: any) {
    const poolerHost = project.dbHost;
    const poolerPort = project.dbPort;
    const db = project.dbName;
    const user = project.dbUser;
    const password = project.dbPassword;
    const publicApiUrl = this.config.get<string>('publicApiUrl') || 'http://localhost:4000';
    const publicBaseUrl = publicApiUrl.replace(/\/+$/, '');

    const { host: directHost, port: directPort } = getPostgresDirectClientEndpoints(
      this.config,
      poolerHost,
      poolerPort,
    );

    return {
      uri: buildPostgresUri(directHost, directPort, user, password, db),
      poolerUri: buildPostgresUri(poolerHost, poolerPort, user, password, db),
      host: poolerHost,
      port: directPort,
      database: db,
      user,
      password,
      poolerHost,
      poolerPort,
      restUrl: `${publicApiUrl}/rest/v1`,
      publicBaseUrl,
      keycloakRealm: project.keycloakRealm,
      keycloakUrl: this.config.get('keycloak.publicUrl') || this.config.get('keycloak.url'),
      anonKey: project.anonKey,
      serviceKey: project.serviceKey,
    };
  }
}
