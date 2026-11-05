import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateNotificationInput {
  type: string;
  title: string;
  message: string;
  href?: string;
  dedupeKey?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, input: CreateNotificationInput) {
    const { dedupeKey } = input;
    const find = () =>
      dedupeKey ? this.prisma.notification.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey } } }) : null;
    const existing = await find();
    if (existing) return existing;
    try {
      const row = await this.prisma.notification.create({ data: { ...input, userId } });
      this.logger.log(`Notification ${row.id} (${row.type}) stored for user ${userId}`);
      return row;
    } catch (err) {
      // Two tabs racing on the same dedupeKey: the loser returns the winner's row.
      const winner = await find();
      if (winner) return winner;
      throw err;
    }
  }

  async list(userId: string, limit = 50, before?: string) {
    const take = Math.min(Math.max(limit, 1), 100);
    const where = { userId, ...(before ? { createdAt: { lt: new Date(before) } } : {}) };
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items, unreadCount, nextBefore: items.length === take ? items[take - 1].createdAt : null };
  }

  async markRead(userId: string, id: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (!count) {
      // Already read is fine; someone else's row or a missing id is a 404.
      const own = await this.prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
      if (!own) throw new NotFoundException('Notification not found');
    }
    return { success: true };
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }
}
