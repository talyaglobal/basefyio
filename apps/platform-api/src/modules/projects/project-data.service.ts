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

  private async getProjectPool(projectId: string, userId?: string): Promise<{ pool: Pool; project: any }> {
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

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 15_000,
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
      // the whole table.
      //
      // Trick: cast each row to jsonb (`to_jsonb(t)`) and iterate its values
      // as text via `jsonb_each_text`. This lets us search across every
      // column — text, numeric, dates, bools, even jsonb — without enumerating
      // column names per-request. The downside is a full table scan; for huge
      // tables the user should add column-level indexes (pg_trgm gin) but a
      // 1.5M-row scan still completes in seconds, which is way better than
      // silently dropping rows because they happen not to be on page 4/363.
      let where = '';
      const params: any[] = [];
      if (trimmedSearch) {
        params.push(`%${trimmedSearch}%`);
        where = `WHERE EXISTS (SELECT 1 FROM jsonb_each_text(to_jsonb(t)) AS kv(k, v) WHERE v ILIKE $${params.length})`;
      }

      const fromClause = `FROM ${qualified} t`;

      // When searching we cap COUNT(*) at 10k to keep response time bounded.
      // Without the cap, counting filtered rows on a 50M-row table can take
      // longer than the user is willing to wait. The frontend treats totals
      // >= 10000 as approximate ("10.000+ rows match").
      let countSql: string;
      if (trimmedSearch) {
        countSql = `SELECT COUNT(*)::int AS total FROM (SELECT 1 ${fromClause} ${where} LIMIT 10001) sub`;
      } else {
        countSql = `SELECT COUNT(*)::int AS total ${fromClause}`;
      }

      const countResult = await client.query(countSql, params);
      const rawTotal = countResult.rows[0].total as number;
      const totalIsApprox = trimmedSearch ? rawTotal > 10000 : false;
      const total = totalIsApprox ? 10000 : rawTotal;

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
