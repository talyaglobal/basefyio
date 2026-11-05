import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/** In-memory stand-in honouring the where clauses markRead uses. */
function fakePrisma() {
  const rows = [{ id: 'n1', userId: 'alice', readAt: null as Date | null }];
  return {
    rows,
    notification: {
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter((r) => r.id === where.id && r.userId === where.userId && !r.readAt);
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      findFirst: async ({ where }: any) => rows.find((r) => r.id === where.id && r.userId === where.userId) ?? null,
    },
  };
}

describe('NotificationsService.markRead', () => {
  it('marks the owner row read', async () => {
    const p = fakePrisma();
    await new NotificationsService(p as any).markRead('alice', 'n1');
    expect(p.rows[0].readAt).toBeInstanceOf(Date);
  });

  it('refuses another user and leaves the row unread', async () => {
    const p = fakePrisma();
    await expect(new NotificationsService(p as any).markRead('bob', 'n1')).rejects.toBeInstanceOf(NotFoundException);
    expect(p.rows[0].readAt).toBeNull();
  });

  it('is idempotent for an already-read own row', async () => {
    const s = new NotificationsService(fakePrisma() as any);
    await s.markRead('alice', 'n1');
    await expect(s.markRead('alice', 'n1')).resolves.toEqual({ success: true });
  });
});
