import { NotificationsService } from './notifications.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('NotificationsService.clear', () => {
  it('deletes only the caller rows and leaves other users untouched', async () => {
    const rows = [{ userId: 'alice' }, { userId: 'alice' }, { userId: 'bob' }];
    const prisma = {
      notification: {
        deleteMany: async ({ where }: any) => {
          const keep = rows.filter((r) => r.userId !== where.userId);
          const count = rows.length - keep.length;
          rows.splice(0, rows.length, ...keep);
          return { count };
        },
      },
    };
    await expect(new NotificationsService(prisma as any).clear('alice')).resolves.toEqual({ deleted: 2 });
    expect(rows).toEqual([{ userId: 'bob' }]);
  });
});
