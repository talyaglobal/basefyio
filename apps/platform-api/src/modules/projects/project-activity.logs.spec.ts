jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../embedding/schema-indexer.service', () => ({ SchemaIndexerService: class {} }));
jest.mock('../../common/realtime/realtime-events.service', () => ({ RealtimeEventsService: class {} }));
import { ProjectActivityService } from './project-activity.service';

/** #27: the log is searched on the server and live rows carry the actor's name. */
function build() {
  const prisma = {
    project: { findFirst: jest.fn(async () => ({ id: 'p1', teamId: 't1' })), findUnique: jest.fn(async () => ({ teamId: 't1' })) },
    teamMember: { findUnique: jest.fn(async () => ({ role: 'MEMBER' })) },
    projectActivityLog: {
      count: jest.fn(async () => 1),
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => ({ id: 'a1' })),
    },
    user: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => ({ firstName: 'Ada', lastName: 'L', email: 'a@b.c' })) },
  };
  const realtime = { publish: jest.fn(async () => undefined) };
  const svc = new ProjectActivityService(prisma as any, realtime as any, { indexProjectSchema: jest.fn() } as any);
  return { svc, prisma, realtime };
}

describe('ProjectActivityService (#27)', () => {
  it('searches the whole history on the server, with type and date filters', async () => {
    const { svc, prisma } = build();
    const from = new Date('2026-11-01T00:00:00Z');
    await svc.listForProject('p1', 'u1', { q: 'flow', kind: 'flow.', from });
    const where = (prisma.projectActivityLog.count.mock.calls as any)[0][0].where;
    expect(where.projectId).toBe('p1');
    expect(where.OR).toHaveLength(3);
    expect(where.kind).toEqual({ startsWith: 'flow.' });
    expect(where.createdAt).toEqual({ gte: from });
    expect((prisma.projectActivityLog.findMany.mock.calls as any)[0][0].where).toBe(where);
  });

  it('reads the history of a trashed project for a team member (#190)', async () => {
    const { svc, prisma } = build();
    await svc.listForProject('p1', 'u1');
    const where = (prisma.project.findFirst.mock.calls as any)[0][0].where;
    expect(where).toEqual({ id: 'p1' });
  });

  it('answers 404 to someone outside the team', async () => {
    const { svc, prisma } = build();
    prisma.teamMember.findUnique.mockResolvedValueOnce(null as any);
    await expect(svc.listForProject('p1', 'u9')).rejects.toThrow('Project not found');
  });

  it('publishes the actor name with a live row', async () => {
    const { svc, realtime } = build();
    await svc.append('p1', { userId: 'u1', kind: 'flow.created' as any, title: 'Flow created: x' });
    expect((realtime.publish.mock.calls as any)[0][0].payload.actorName).toBe('Ada L');
  });
});
