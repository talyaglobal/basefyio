import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';

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
      return result.rows;
    } finally {
      client.release();
      await pool.end();
    }
  }

  async getColumns(projectId: string, ownerId: string | undefined, tableName: string): Promise<ColumnInfo[]> {
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
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
          AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY c.ordinal_position
        `,
        [tableName],
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
  ) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new BadRequestException('Invalid table name');
    }

    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();
    const offset = (page - 1) * limit;

    try {
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM "${tableName}"`,
      );
      const total = countResult.rows[0].total;

      const dataResult = await client.query(
        `SELECT * FROM "${tableName}" LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      return {
        rows: dataResult.rows,
        fields: dataResult.fields?.map((f) => ({
          name: f.name,
          dataTypeId: f.dataTypeID,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
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
  ) {
    this.validateTableName(tableName);
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const keys = Object.keys(data).filter((k) => data[k] !== undefined && data[k] !== '');
      if (!keys.length) throw new BadRequestException('No data provided');

      const cols = keys.map((k) => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const values = keys.map((k) => data[k] === null || data[k] === 'NULL' ? null : data[k]);

      const result = await client.query(
        `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) RETURNING *`,
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
  ) {
    this.validateTableName(tableName);
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
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
        `UPDATE "${tableName}" SET ${setClause} WHERE ${whereClause} RETURNING *`,
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
  ) {
    this.validateTableName(tableName);
    const { pool } = await this.getProjectPool(projectId, ownerId);
    const client = await pool.connect();

    try {
      const whereCols = Object.keys(pkWhere);
      if (!whereCols.length) throw new BadRequestException('No primary key provided');

      const whereClause = whereCols
        .map((k, i) => `"${k}" = $${i + 1}`)
        .join(' AND ');
      const values = whereCols.map((k) => pkWhere[k]);

      const result = await client.query(
        `DELETE FROM "${tableName}" WHERE ${whereClause}`,
        values,
      );

      if (result.rowCount === 0) throw new NotFoundException('Row not found');
      return { message: 'Row deleted' };
    } finally {
      client.release();
      await pool.end();
    }
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

  getConnectionStrings(project: any) {
    const host = project.dbHost;
    const port = project.dbPort;
    const db = project.dbName;
    const user = project.dbUser;
    const password = project.dbPassword;

    const poolerHost = this.config.get<string>('pgbouncer.externalHost') || 'localhost';
    const poolerPort = this.config.get<number>('pgbouncer.externalPort') || 6432;
    const publicApiUrl = this.config.get<string>('publicApiUrl') || 'http://localhost:4000';

    return {
      uri: `postgresql://${user}:${password}@${host}:${port}/${db}`,
      poolerUri: `postgresql://${user}:${password}@${poolerHost}:${poolerPort}/${db}`,
      host,
      port,
      database: db,
      user,
      password,
      poolerHost,
      poolerPort,
      restUrl: `${publicApiUrl}/rest/v1`,
      keycloakRealm: project.keycloakRealm,
      keycloakUrl: this.config.get('keycloak.publicUrl') || this.config.get('keycloak.url'),
      anonKey: project.anonKey,
      serviceKey: project.serviceKey,
    };
  }
}
