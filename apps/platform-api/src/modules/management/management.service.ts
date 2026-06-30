import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const STATUSES = ['todo', 'in_progress', 'done'] as const;
type Status = (typeof STATUSES)[number];

@Injectable()
export class ManagementService {
  constructor(private readonly prisma: PrismaService) {}

  async getBoard(board: string) {
    const items = await this.prisma.managementChecklistItem.findMany({
      where: { board },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    const done = items.filter((i) => i.status === 'done').length;
    const inProgress = items.filter((i) => i.status === 'in_progress').length;
    return {
      board,
      items,
      summary: {
        total: items.length,
        done,
        inProgress,
        todo: items.length - done - inProgress,
        progressPct: items.length ? Math.round((done / items.length) * 100) : 0,
      },
    };
  }

  async addItem(
    board: string,
    data: { section?: string; title: string; detail?: string; position?: number },
  ) {
    const max = await this.prisma.managementChecklistItem.aggregate({
      where: { board },
      _max: { position: true },
    });
    return this.prisma.managementChecklistItem.create({
      data: {
        board,
        section: data.section?.trim() || 'General',
        title: data.title.trim(),
        detail: data.detail?.trim() || null,
        position: data.position ?? (max._max.position ?? 0) + 1,
      },
    });
  }

  async updateItem(
    board: string,
    id: string,
    data: { status?: string; notes?: string; title?: string; detail?: string; section?: string; position?: number },
  ) {
    const existing = await this.prisma.managementChecklistItem.findFirst({ where: { id, board } });
    if (!existing) throw new NotFoundException('Checklist item not found');
    const patch: Record<string, unknown> = {};
    if (data.status && (STATUSES as readonly string[]).includes(data.status)) patch.status = data.status as Status;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.title !== undefined) patch.title = data.title;
    if (data.detail !== undefined) patch.detail = data.detail;
    if (data.section !== undefined) patch.section = data.section;
    if (data.position !== undefined) patch.position = data.position;
    return this.prisma.managementChecklistItem.update({ where: { id }, data: patch });
  }

  async deleteItem(board: string, id: string) {
    const existing = await this.prisma.managementChecklistItem.findFirst({ where: { id, board } });
    if (!existing) throw new NotFoundException('Checklist item not found');
    await this.prisma.managementChecklistItem.delete({ where: { id } });
    return { message: 'Deleted' };
  }
}
