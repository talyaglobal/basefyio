import { ObservabilityService } from './observability.service';

function build(total: number) {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(total);
  const prisma = { auditLog: { findMany, count }, user: { findMany: jest.fn().mockResolvedValue([]) } };
  return { svc: new ObservabilityService(prisma as any, {} as any), findMany, count };
}

describe('ObservabilityService.listAuditLogs paging', () => {
  it('pins every page to the snapshot time and clamps a page past the end', async () => {
    const { svc, findMany } = build(120);
    const res = await svc.listAuditLogs({ page: 99, limit: 50, asOf: '2026-11-09T10:00:00.000Z' });
    expect(res.page).toBe(3);
    expect(res.asOf).toBe('2026-11-09T10:00:00.000Z');
    expect(findMany.mock.calls[0][0].where.AND[0]).toEqual({ createdAt: { lte: new Date('2026-11-09T10:00:00.000Z') } });
  });

  it('reads the last page from the oldest end and returns it newest first', async () => {
    const { svc, findMany } = build(120);
    findMany.mockResolvedValue([{ id: 'oldest' }, { id: 'newer' }]);
    const res = await svc.listAuditLogs({ page: 3, limit: 50 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ orderBy: { createdAt: 'asc' }, take: 20, skip: 0 });
    expect(res.data.map((r: any) => r.id)).toEqual(['newer', 'oldest']);
  });

  it('escapes wildcards in the search term', async () => {
    const { svc, findMany } = build(0);
    await svc.listAuditLogs({ search: '50%_' });
    const or = findMany.mock.calls[0][0].where.AND.find((c: any) => c.OR).OR;
    expect(or[0].action.contains).toBe('50\\%\\_');
  });
});

describe('ObservabilityService.listAuditLogs search and dates (#189)', () => {
  it('matches actors by e-mail or name through the user table', async () => {
    const { svc, findMany } = build(0);
    const prisma = (svc as any).prisma;
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'u-1' }]);
    await svc.listAuditLogs({ search: 'faruk@x.io' });
    const userWhere = prisma.user.findMany.mock.calls[0][0].where.OR;
    expect(userWhere[0].email.contains).toBe('faruk@x.io');
    const or = findMany.mock.calls[0][0].where.AND.find((c: any) => c.OR).OR;
    expect(or[0]).toEqual({ actorUserId: { in: ['u-1'] } });
  });

  it('accepts ISO datetimes and ignores garbage instead of failing', async () => {
    const { svc, findMany } = build(0);
    await svc.listAuditLogs({ dateFrom: '2026-10-21T20:00:00Z', dateTo: 'nonsense' });
    const and = findMany.mock.calls[0][0].where.AND;
    expect(and[1]).toEqual({ createdAt: { gte: new Date('2026-10-21T20:00:00Z') } });
    expect(and).toHaveLength(2);
  });

  it('shows the real role for rows stored as UNKNOWN', async () => {
    const { svc, findMany } = build(1);
    const prisma = (svc as any).prisma;
    findMany.mockResolvedValue([{ id: 'r', actorUserId: 'u-root', actorRole: 'UNKNOWN', resourceType: 'x', resourceId: null }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u-root', email: 'r@x.io', firstName: 'R', lastName: null, role: 'ROOT' }]);
    const res = await svc.listAuditLogs({});
    expect((res.data[0] as any).actorRole).toBe('ROOT');
  });
});
