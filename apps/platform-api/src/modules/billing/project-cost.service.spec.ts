import { ProjectCostService } from './project-cost.service';

const GB = 1024 ** 3;

const project = (id: string, dbGb: number, api: number, bytes: number) => ({
  id,
  name: id,
  slug: id,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  infrastructure: null,
  usage: {
    dbSizeBytes: BigInt(Math.round(dbGb * GB)),
    storageBytes: BigInt(0),
    apiRequestsMonth: api,
    bandwidthMonth: BigInt(bytes),
    dbSizeCalculatedAt: new Date(),
    storageCalculatedAt: new Date(),
  },
});

describe('ProjectCostService.getTeamReport', () => {
  const build = (rows: any[]) => {
    const prisma: any = {
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      subscription: { findUnique: jest.fn().mockResolvedValue(null) },
      project: { findMany: jest.fn().mockResolvedValue(rows), count: jest.fn().mockResolvedValue(0) },
    };
    const usage: any = { getLiveProjectCounters: jest.fn().mockResolvedValue(new Map()) };
    return new ProjectCostService(prisma, usage);
  };

  it('totals are the sum of the cents shown on the rows', async () => {
    // At this instant the unrounded rows add to 232 cents while the rounded rows show 231.
    jest.useFakeTimers({ now: new Date('2026-11-09T12:00:00Z') });
    const rows = [project('a', 0.71, 10_000, 1e8), project('b', 0.73, 10_000, 1e8), project('c', 0.77, 10_000, 1e8)];
    const report = await build(rows).getTeamReport('t1');
    const shown = report.projects.reduce((s, p) => s + Math.round(p.amountUsd * 100), 0);
    expect(Math.round(report.totals.amountUsd * 100)).toBe(shown);
    const projected = report.projects.reduce((s, p) => s + Math.round(p.projectedUsd * 100), 0);
    expect(Math.round(report.totals.projectedUsd * 100)).toBe(projected);
    jest.useRealTimers();
  });

  it('reports what the projects metered, for reconciling with the team Usage card', async () => {
    const rows = [project('a', 0, 10_000, 5), project('b', 0, 590, 7)];
    const report = await build(rows).getTeamReport('t1');
    
  });
});
