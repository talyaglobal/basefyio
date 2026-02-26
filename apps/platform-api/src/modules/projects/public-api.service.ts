import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';

interface ParsedFilter {
  clause: string;
  values: unknown[];
}

const OPERATOR_MAP: Record<string, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  is: 'IS',
  in: 'IN',
};

const RESERVED_PARAMS = new Set([
  'select', 'order', 'limit', 'offset', 'on_conflict',
]);

@Injectable()
export class PublicApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async select(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
  ) {
    this.validateTableName(table);
    const pool = await this.getPool(projectId);

    try {
      const columns = this.parseSelect(query.select as string);
      const { where, params } = this.parseFilters(query);
      const orderBy = this.parseOrder(query.order as string);
      const { limitClause, limitParams } = this.parsePagination(query, params.length);

      const sql = [
        `SELECT ${columns} FROM "${table}"`,
        where ? `WHERE ${where}` : '',
        orderBy ? `ORDER BY ${orderBy}` : '',
        limitClause,
      ].filter(Boolean).join(' ');

      const allParams = [...params, ...limitParams];

      const countSql = `SELECT COUNT(*)::int AS total FROM "${table}"${where ? ` WHERE ${where}` : ''}`;
      const [dataResult, countResult] = await Promise.all([
        pool.query(sql, allParams),
        pool.query(countSql, params),
      ]);

      return {
        data: dataResult.rows,
        count: countResult.rows[0]?.total ?? 0,
      };
    } finally {
      await pool.end();
    }
  }

  async insert(
    projectId: string,
    table: string,
    body: Record<string, unknown> | Record<string, unknown>[],
    returnRepresentation: boolean,
  ) {
    this.validateTableName(table);
    const pool = await this.getPool(projectId);

    try {
      const rows = Array.isArray(body) ? body : [body];
      if (!rows.length) throw new BadRequestException('Empty body');

      const keys = Object.keys(rows[0]);
      if (!keys.length) throw new BadRequestException('No columns provided');

      const cols = keys.map((k) => `"${this.sanitizeIdentifier(k)}"`).join(', ');

      const allValues: unknown[] = [];
      const valueGroups: string[] = [];

      for (const row of rows) {
        const placeholders: string[] = [];
        for (const key of keys) {
          allValues.push(row[key] ?? null);
          placeholders.push(`$${allValues.length}`);
        }
        valueGroups.push(`(${placeholders.join(', ')})`);
      }

      const returning = returnRepresentation ? ' RETURNING *' : '';
      const sql = `INSERT INTO "${table}" (${cols}) VALUES ${valueGroups.join(', ')}${returning}`;

      const result = await pool.query(sql, allValues);
      return returnRepresentation ? result.rows : { count: result.rowCount };
    } finally {
      await pool.end();
    }
  }

  async update(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
    body: Record<string, unknown>,
    returnRepresentation: boolean,
  ) {
    this.validateTableName(table);
    const pool = await this.getPool(projectId);

    try {
      const { where, params } = this.parseFilters(query);
      if (!where) {
        throw new BadRequestException('PATCH requires at least one filter to prevent full-table updates');
      }

      const setCols = Object.keys(body);
      if (!setCols.length) throw new BadRequestException('No data to update');

      let idx = params.length;
      const setClause = setCols
        .map((k) => {
          idx++;
          return `"${this.sanitizeIdentifier(k)}" = $${idx}`;
        })
        .join(', ');

      const setValues = setCols.map((k) => body[k] ?? null);
      const returning = returnRepresentation ? ' RETURNING *' : '';
      const sql = `UPDATE "${table}" SET ${setClause} WHERE ${where}${returning}`;

      const result = await pool.query(sql, [...params, ...setValues]);
      return returnRepresentation ? result.rows : { count: result.rowCount };
    } finally {
      await pool.end();
    }
  }

  async delete(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
    returnRepresentation: boolean,
  ) {
    this.validateTableName(table);
    const pool = await this.getPool(projectId);

    try {
      const { where, params } = this.parseFilters(query);
      if (!where) {
        throw new BadRequestException('DELETE requires at least one filter to prevent full-table deletes');
      }

      const returning = returnRepresentation ? ' RETURNING *' : '';
      const sql = `DELETE FROM "${table}" WHERE ${where}${returning}`;

      const result = await pool.query(sql, params);
      return returnRepresentation ? result.rows : { count: result.rowCount };
    } finally {
      await pool.end();
    }
  }

  private parseSelect(selectParam?: string): string {
    if (!selectParam) return '*';

    const cols = selectParam.split(',').map((c) => c.trim()).filter(Boolean);
    if (!cols.length) return '*';

    return cols
      .map((c) => `"${this.sanitizeIdentifier(c)}"`)
      .join(', ');
  }

  private parseFilters(
    query: Record<string, string | string[]>,
  ): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const [key, raw] of Object.entries(query)) {
      if (RESERVED_PARAMS.has(key)) continue;
      if (!key.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) continue;

      const values = Array.isArray(raw) ? raw : [raw];

      for (const value of values) {
        const parsed = this.parseOperatorValue(key, value, params.length);
        if (parsed) {
          clauses.push(parsed.clause);
          params.push(...parsed.values);
        }
      }
    }

    return {
      where: clauses.length ? clauses.join(' AND ') : '',
      params,
    };
  }

  private parseOperatorValue(
    column: string,
    value: string,
    paramOffset: number,
  ): ParsedFilter | null {
    const dotIdx = value.indexOf('.');
    if (dotIdx === -1) return null;

    const op = value.substring(0, dotIdx);
    const val = value.substring(dotIdx + 1);
    const sqlOp = OPERATOR_MAP[op];

    if (!sqlOp) return null;

    const col = `"${this.sanitizeIdentifier(column)}"`;

    if (op === 'is') {
      if (val === 'null') return { clause: `${col} IS NULL`, values: [] };
      if (val === 'true') return { clause: `${col} IS TRUE`, values: [] };
      if (val === 'false') return { clause: `${col} IS FALSE`, values: [] };
      return null;
    }

    if (op === 'in') {
      const items = val
        .replace(/^\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .map((s) => s.trim());

      const placeholders: string[] = [];
      const values: unknown[] = [];
      for (const item of items) {
        values.push(item);
        placeholders.push(`$${paramOffset + values.length}`);
      }

      return {
        clause: `${col} IN (${placeholders.join(', ')})`,
        values,
      };
    }

    if (op === 'like' || op === 'ilike') {
      const pattern = val.replace(/\*/g, '%');
      return {
        clause: `${col} ${sqlOp} $${paramOffset + 1}`,
        values: [pattern],
      };
    }

    return {
      clause: `${col} ${sqlOp} $${paramOffset + 1}`,
      values: [val],
    };
  }

  private parseOrder(orderParam?: string): string {
    if (!orderParam) return '';

    return orderParam
      .split(',')
      .map((part) => {
        const [col, dir] = part.trim().split('.');
        const safeCol = `"${this.sanitizeIdentifier(col)}"`;
        const safeDir = dir?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        const nulls = safeDir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';
        return `${safeCol} ${safeDir} ${nulls}`;
      })
      .join(', ');
  }

  private parsePagination(
    query: Record<string, string | string[]>,
    paramOffset: number,
  ): { limitClause: string; limitParams: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];

    const limit = parseInt(query.limit as string, 10);
    if (!isNaN(limit) && limit > 0) {
      params.push(Math.min(limit, 1000));
      parts.push(`LIMIT $${paramOffset + params.length}`);
    } else {
      params.push(100);
      parts.push(`LIMIT $${paramOffset + params.length}`);
    }

    const offset = parseInt(query.offset as string, 10);
    if (!isNaN(offset) && offset > 0) {
      params.push(offset);
      parts.push(`OFFSET $${paramOffset + params.length}`);
    }

    return { limitClause: parts.join(' '), limitParams: params };
  }

  private validateTableName(name: string) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new BadRequestException('Invalid table name');
    }
  }

  private sanitizeIdentifier(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '');
  }

  private async getPool(projectId: string): Promise<Pool> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: { dbHost: true, dbPort: true, dbUser: true, dbPassword: true, dbName: true },
    });

    if (!project) {
      throw new ForbiddenException('Project not found or inactive');
    }

    return new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 15_000,
    });
  }
}
