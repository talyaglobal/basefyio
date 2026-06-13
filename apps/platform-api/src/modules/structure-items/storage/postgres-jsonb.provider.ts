import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  DataStorageProvider,
  DeleteRowInput,
  GetRowInput,
  InsertRowInput,
  ListRowsInput,
  PaginatedRows,
  StoredRow,
  UpdateRowInput,
} from './data-storage.provider';

function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

function toStoredRow(row: {
  id: string;
  data: unknown;
  createdAt: Date;
  updatedAt: Date;
}): StoredRow {
  return {
    id: row.id,
    data: (row.data ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PostgresJsonbProvider implements DataStorageProvider {
  constructor(private readonly prisma: PrismaService) {}

  async insertRow(input: InsertRowInput): Promise<StoredRow> {
    const row = await this.prisma.structureItem.create({
      data: {
        dataStructureId: input.structureId,
        projectId: input.projectId,
        data: input.data as any,
      },
      select: { id: true, data: true, createdAt: true, updatedAt: true },
    });
    return toStoredRow(row);
  }

  async getRow(input: GetRowInput): Promise<StoredRow | null> {
    const row = await this.prisma.structureItem.findFirst({
      where: {
        id: input.itemId,
        dataStructureId: input.structureId,
        projectId: input.projectId,
      },
      select: { id: true, data: true, createdAt: true, updatedAt: true },
    });
    return row ? toStoredRow(row) : null;
  }

  async listRows(input: ListRowsInput): Promise<PaginatedRows> {
    const limit = Math.min(input.limit, 100);
    const cursorId = input.cursor ? decodeCursor(input.cursor) : undefined;

    const where = {
      dataStructureId: input.structureId,
      projectId: input.projectId,
      ...(cursorId ? { id: { gt: cursorId } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.structureItem.count({
        where: { dataStructureId: input.structureId, projectId: input.projectId },
      }),
      this.prisma.structureItem.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: limit + 1,
        select: { id: true, data: true, createdAt: true, updatedAt: true },
      }),
    ]);

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

    return { data: rows.map(toStoredRow), nextCursor, total };
  }

  async updateRow(input: UpdateRowInput): Promise<StoredRow> {
    const existing = await this.prisma.structureItem.findFirst({
      where: {
        id: input.itemId,
        dataStructureId: input.structureId,
        projectId: input.projectId,
      },
      select: { id: true, data: true },
    });
    if (!existing) throw new Error('NOT_FOUND');

    const merged = { ...(existing.data as Record<string, unknown>), ...input.data };
    const row = await this.prisma.structureItem.update({
      where: { id: input.itemId },
      data: { data: merged as any },
      select: { id: true, data: true, createdAt: true, updatedAt: true },
    });
    return toStoredRow(row);
  }

  async deleteRow(input: DeleteRowInput): Promise<void> {
    const existing = await this.prisma.structureItem.findFirst({
      where: {
        id: input.itemId,
        dataStructureId: input.structureId,
        projectId: input.projectId,
      },
      select: { id: true },
    });
    if (!existing) throw new Error('NOT_FOUND');
    await this.prisma.structureItem.delete({ where: { id: input.itemId } });
  }
}
