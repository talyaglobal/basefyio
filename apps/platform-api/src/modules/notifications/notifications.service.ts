import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

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

  /** Delete the caller's own notifications; other users' rows are never matched. */
  async clear(userId: string) {
    const { count } = await this.prisma.notification.deleteMany({ where: { userId } });
    return { deleted: count };
  }
}
