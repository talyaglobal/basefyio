import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Pool } from 'pg';

export interface ItemsPage<T> {
  data: T[];
  nextCursor: string | null;
  total: number;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new BadRequestException(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveEntity(projectId: string, entityName: string) {
    const entity = await (this.prisma as any).appEntity.findFirst({
      where: { projectId, entityName: { equals: entityName, mode: 'insensitive' } },
    });
    if (!entity) {
      // Fall back: try tableName match
      const byTable = await (this.prisma as any).appEntity.findFirst({
        where: { projectId, tableName: { equals: entityName, mode: 'insensitive' } },
      });
      if (!byTable) throw new NotFoundException(`Entity '${entityName}' not found in project`);
      return byTable;
    }
    return entity;
  }

  private async getPool(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');
    return {
      pool: new Pool({
        host: project.dbHost,
        port: project.dbPort,
        database: project.dbName,
        user: project.dbUser,
        password: project.dbPassword,
        statement_timeout: 10_000,
        max: 2,
      }),
      project,
    };
  }

  async listItems(
    projectId: string,
    entityName: string,
    opts: {
      filters?: Record<string, string>;
      sort?: string;
      order?: 'asc' | 'desc';
      limit?: number;
      cursor?: string;
    },
  ): Promise<ItemsPage<Record<string, unknown>>> {
    const entity = await this.resolveEntity(projectId, entityName);
    const table = quoteIdent(entity.tableName);
    const limit = Math.min(opts.limit ?? 20, 100);
    const order = opts.order === 'asc' ? 'ASC' : 'DESC';
    const sortCol = opts.sort ? quoteIdent(opts.sort) : quoteIdent('created_at');

    const params: unknown[] = [];
    const whereParts: string[] = [];

    // Cursor pagination: WHERE id > :cursor (for asc) or id < :cursor (for desc)
    if (opts.cursor) {
      const cursorId = decodeCursor(opts.cursor);
      params.push(cursorId);
      whereParts.push(`"id" ${order === 'DESC' ? '<' : '>'} $${params.length}`);
    }

    // Filters: only allow safe column names
    if (opts.filters) {
      for (const [col, val] of Object.entries(opts.filters)) {
        try {
          const quotedCol = quoteIdent(col);
          params.push(val);
          whereParts.push(`${quotedCol} = $${params.length}`);
        } catch {
          // Skip unsafe column names silently
        }
      }
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const sql = `SELECT * FROM ${table} ${whereClause} ORDER BY ${sortCol} ${order} LIMIT ${limit + 1}`;

    const { pool } = await this.getPool(projectId);
    try {
      // Count query (for total — approximate for large tables)
      const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM ${table} ${whereClause}`, params);
      const total = countResult.rows[0]?.total ?? 0;

      const result = await pool.query(sql, params);
      const rows = result.rows;
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();

      const lastRow = rows[rows.length - 1];
      const nextCursor = hasMore && lastRow ? encodeCursor(String(lastRow['id'])) : null;

      return { data: rows, nextCursor, total };
    } finally {
      await pool.end();
    }
  }

  async getItem(
    projectId: string,
    entityName: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    const entity = await this.resolveEntity(projectId, entityName);
    const table = quoteIdent(entity.tableName);
    const { pool } = await this.getPool(projectId);
    try {
      const result = await pool.query(`SELECT * FROM ${table} WHERE "id" = $1`, [id]);
      if (result.rows.length === 0) throw new NotFoundException(`Item '${id}' not found`);
      return result.rows[0];
    } finally {
      await pool.end();
    }
  }

  async createItem(
    projectId: string,
    entityName: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const entity = await this.resolveEntity(projectId, entityName);
    const table = quoteIdent(entity.tableName);

    // Only allow safe field names; strip id/created_at/updated_at
    const safeFields = Object.entries(data).filter(([k]) => {
      try { quoteIdent(k); return !['id', 'created_at', 'updated_at'].includes(k); }
      catch { return false; }
    });

    if (safeFields.length === 0) {
      throw new BadRequestException('No valid fields to insert');
    }

    const cols = safeFields.map(([k]) => quoteIdent(k)).join(', ');
    const placeholders = safeFields.map((_, i) => `$${i + 1}`).join(', ');
    const values = safeFields.map(([, v]) => v);

    const { pool } = await this.getPool(projectId);
    try {
      const result = await pool.query(
        `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      return result.rows[0];
    } finally {
      await pool.end();
    }
  }

  async updateItem(
    projectId: string,
    entityName: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const entity = await this.resolveEntity(projectId, entityName);
    const table = quoteIdent(entity.tableName);

    const safeFields = Object.entries(data).filter(([k]) => {
      try { quoteIdent(k); return !['id', 'created_at', 'updated_at'].includes(k); }
      catch { return false; }
    });

    if (safeFields.length === 0) throw new BadRequestException('No valid fields to update');

    const setClauses = safeFields.map(([k], i) => `${quoteIdent(k)} = $${i + 1}`).join(', ');
    const values = [...safeFields.map(([, v]) => v), id];

    const { pool } = await this.getPool(projectId);
    try {
      const result = await pool.query(
        `UPDATE ${table} SET ${setClauses}, "updated_at" = now() WHERE "id" = $${values.length} RETURNING *`,
        values,
      );
      if (result.rows.length === 0) throw new NotFoundException(`Item '${id}' not found`);
      return result.rows[0];
    } finally {
      await pool.end();
    }
  }

  async deleteItem(
    projectId: string,
    entityName: string,
    id: string,
  ): Promise<{ deleted: boolean; id: string }> {
    const entity = await this.resolveEntity(projectId, entityName);
    const table = quoteIdent(entity.tableName);
    const { pool } = await this.getPool(projectId);
    try {
      const result = await pool.query(`DELETE FROM ${table} WHERE "id" = $1`, [id]);
      if ((result.rowCount ?? 0) === 0) throw new NotFoundException(`Item '${id}' not found`);
      return { deleted: true, id };
    } finally {
      await pool.end();
    }
  }
}
