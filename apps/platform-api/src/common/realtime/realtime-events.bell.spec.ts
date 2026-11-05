jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { RealtimeEventsService } from './realtime-events.service';

describe('RealtimeEventsService bell storage', () => {
  it('stores a row for each recipient except the actor, keyed by eventId, before the push', async () => {
    const order: string[] = [];
    const createMany = jest.fn(async (_arg: any) => (order.push('db'), { count: 1 }));
    const publish = jest.fn((_e: any) => order.push('push'));
    const svc = new RealtimeEventsService({ publish } as any, { notification: { createMany } } as any);

    await svc.publish({
      entityType: 'feedback',
      action: 'reporter_notified',
      entityId: 'f1',
      actorUserId: 'admin',
      userIds: ['admin', 'reporter'],
      payload: { title: 'T', summary: 'Done.' },
    });

    const arg = createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(1);
    expect(arg.data[0]).toMatchObject({ userId: 'reporter', type: 'feedback', title: 'Update on your feedback' });
    expect(arg.data[0].dedupeKey).toBe(publish.mock.calls[0][0].eventId);
    expect(order).toEqual(['db', 'push']);
  });

  it('stores nothing for events that are not bell notifications', async () => {
    const createMany = jest.fn();
    const svc = new RealtimeEventsService({ publish: jest.fn() } as any, { notification: { createMany } } as any);
    await svc.publish({ entityType: 'billing', action: 'updated', entityId: 'b', userIds: ['u'] });
    expect(createMany).not.toHaveBeenCalled();
  });
});
