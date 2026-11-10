import { ObservabilityService } from './observability.service';

const PID = '2abaadce-0000-4000-8000-000000000001';
const TID = 'c7f2d385-0000-4000-8000-000000000002';

function build() {
  const prisma = {
    auditLog: { findMany: jest.fn(), count: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', email: 'a@b.c', firstName: 'Ada', lastName: 'L' }]) },
    team: { findMany: jest.fn().mockResolvedValue([{ id: TID, name: 'Acme' }]) },
    project: { findMany: jest.fn().mockResolvedValue([{ id: PID, name: 'Shop' }]) },
  };
  return { svc: new ObservabilityService(prisma as any, {} as any), prisma };
}

describe('ObservabilityService audit labels', () => {
  it('names project-key actors and team/project targets instead of showing ids', async () => {
    const { svc } = build();
    const rows = [
      { actorUserId: `project:${PID}`, resourceType: 'team', resourceId: TID },
      { actorUserId: `project:${PID}/user:u1`, resourceType: 'projects', resourceId: PID },
      { actorUserId: 'u1', resourceType: 'server', resourceId: 'srv-1' },
    ];
    const out = await (svc as any).attachUserLabelsToAuditLogs(rows);
    expect(out[0].actorDisplayName).toBe('Project key · Shop');
    expect(out[0].resourceDisplayName).toBe('Team: Acme');
    expect(out[1].actorDisplayName).toBe('Project key · Shop (as Ada L (a@b.c))');
    expect(out[1].resourceDisplayName).toBe('Project: Shop');
    expect(out[2].actorDisplayName).toBe('Ada L (a@b.c) · id u1');
    expect(out[2].resourceDisplayName).toBe('server: srv-1');
  });
});
