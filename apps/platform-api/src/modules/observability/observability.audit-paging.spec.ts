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
