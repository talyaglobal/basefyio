import { BadRequestException } from '@nestjs/common';
import {
  ObservabilityService,
  displayProjectName,
  parseAuditDate,
  parseProjectActor,
} from './observability.service';

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      ...overrides.auditLog,
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.user,
    },
    project: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.project,
    },
    rootAlert: {
      create: jest.fn().mockResolvedValue({ id: 'alert-1', createdAt: new Date() }),
      findFirst: jest.fn().mockResolvedValue(null),
      ...overrides.rootAlert,
    },
  } as any;
}

const email = { sendRawHtml: jest.fn().mockResolvedValue(undefined) } as any;

describe('audit helpers', () => {
  it('parses a day or an ISO timestamp, and refuses garbage with 400', () => {
    expect(parseAuditDate('2026-10-21', 'from').toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(parseAuditDate('2026-10-21', 'to').toISOString()).toBe('2026-10-21T23:59:59.999Z');
    expect(parseAuditDate('2026-10-21T20:00:00Z', 'from').toISOString()).toBe('2026-10-21T20:00:00.000Z');
    expect(() => parseAuditDate('yesterday', 'from')).toThrow(BadRequestException);
  });

  it('reads API-key actors and trashed project names', () => {
    expect(parseProjectActor('project:p1')).toEqual({ projectId: 'p1', endUserId: null });
    expect(parseProjectActor('project:p1/user:u9')).toEqual({ projectId: 'p1', endUserId: 'u9' });
    expect(parseProjectActor('a-user-id')).toBeNull();
    expect(displayProjectName('shop_deleted', 'DELETED')).toBe('shop');
    expect(displayProjectName('shop_2_deleted', 'DELETED')).toBe('shop');
    expect(displayProjectName('shop_deleted', 'ACTIVE')).toBe('shop_deleted');
  });
});

describe('ObservabilityService.listAuditLogs', () => {
  it('finds rows by actor email or name, not only by raw id', async () => {
    const prisma = makePrisma({
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u-faruk' }]) },
    });
    const svc = new ObservabilityService(prisma, email);
    await svc.listAuditLogs({ search: 'faruk karagol' });

    const userWhere = prisma.user.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(userWhere)).toContain('faruk');
    const where = prisma.auditLog.findMany.mock.calls[0][0].where;
    const or = where.AND[0].OR;
    expect(or).toEqual(expect.arrayContaining([{ actorUserId: { in: ['u-faruk'] } }]));
  });

  it('finds API-key rows by the project name', async () => {
    const prisma = makePrisma({
      project: { findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]) },
    });
    const svc = new ObservabilityService(prisma, email);
    await svc.listAuditLogs({ search: 'shop' });
    const or = prisma.auditLog.findMany.mock.calls[0][0].where.AND[0].OR;
    expect(or).toEqual(expect.arrayContaining([{ actorUserId: { startsWith: 'project:p1' } }]));
  });

  it('accepts an ISO timestamp for dateFrom instead of failing with 500', async () => {
    const prisma = makePrisma();
    const svc = new ObservabilityService(prisma, email);
    await svc.listAuditLogs({ dateFrom: '2026-10-21T20:00:00Z' });
    const where = prisma.auditLog.findMany.mock.calls[0][0].where;
    expect(where.AND[0].createdAt.gte.toISOString()).toBe('2026-10-21T20:00:00.000Z');
    await expect(svc.listAuditLogs({ dateFrom: 'not-a-date' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('labels API-key actors with the project and the key, never "Unknown user"', async () => {
    const prisma = makePrisma({
      auditLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'a1',
            actorUserId: 'project:p1',
            actorRole: 'SERVICE_KEY',
            resourceType: 'storage_bucket',
            resourceId: 'avatars',
            action: 'POST /api/projects/p1/storage/buckets',
            metadataJson: { projectId: 'p1' },
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
      project: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'p1', name: 'shop', status: 'ACTIVE', teamId: 't1', team: { name: 'Acme' } },
        ]),
      },
    });
    const svc = new ObservabilityService(prisma, email);
    const res = await svc.listAuditLogs({});
    expect(res.data[0]).toMatchObject({
      actorDisplayName: 'Project "shop" (service key)',
      projectDisplayName: 'shop',
      teamDisplayName: 'Acme',
    });
  });
});

describe('ObservabilityService.evaluateHttpAuditAlerts', () => {
  const base = {
    auditLogId: 'row-1',
    actorUserId: 'u1',
    path: '/api/projects/p1',
    severity: 'HIGH',
    event: null,
  };

  it('raises one alert after repeated refused writes and then stays quiet', async () => {
    const prisma = makePrisma({ auditLog: { count: jest.fn().mockResolvedValue(5) } });
    const svc = new ObservabilityService(prisma, email);
    await svc.evaluateHttpAuditAlerts({ ...base, method: 'POST', statusCode: 403, success: false });
    expect(prisma.rootAlert.create).toHaveBeenCalledTimes(1);
    expect(prisma.rootAlert.create.mock.calls[0][0].data.kind).toBe('REPEATED_FAILED_PRIVILEGED_ACTIONS');

    prisma.rootAlert.findFirst.mockResolvedValue({ id: 'alert-1' });
    await svc.evaluateHttpAuditAlerts({ ...base, method: 'POST', statusCode: 403, success: false });
    expect(prisma.rootAlert.create).toHaveBeenCalledTimes(1);
  });

  it('does not count failed reads', async () => {
    const prisma = makePrisma({ auditLog: { count: jest.fn().mockResolvedValue(50) } });
    const svc = new ObservabilityService(prisma, email);
    await svc.evaluateHttpAuditAlerts({ ...base, method: 'GET', statusCode: 404, success: false });
    expect(prisma.auditLog.count).not.toHaveBeenCalled();
    expect(prisma.rootAlert.create).not.toHaveBeenCalled();
  });

  it('alerts on a permanent project deletion', async () => {
    const prisma = makePrisma();
    const svc = new ObservabilityService(prisma, email);
    await svc.evaluateHttpAuditAlerts({
      ...base,
      method: 'DELETE',
      statusCode: 200,
      success: true,
      severity: 'CRITICAL',
      event: 'project.deleted.permanent',
    });
    expect(prisma.rootAlert.create.mock.calls[0][0].data).toMatchObject({
      kind: 'HIGH_RISK_ACTION:project.deleted.permanent',
      severity: 'CRITICAL',
    });
  });

  it('alerts on a burst of deletions', async () => {
    const prisma = makePrisma({ auditLog: { count: jest.fn().mockResolvedValue(10) } });
    const svc = new ObservabilityService(prisma, email);
    await svc.evaluateHttpAuditAlerts({ ...base, method: 'DELETE', statusCode: 200, success: true });
    expect(prisma.rootAlert.create.mock.calls[0][0].data.kind).toBe('BULK_DESTRUCTIVE_ACTIONS');
  });

  it('escapes the request path in the alert email', async () => {
    const prisma = makePrisma({
      auditLog: { count: jest.fn().mockResolvedValue(5) },
      user: { findMany: jest.fn().mockResolvedValue([{ email: 'root@example.com' }]) },
    });
    const mail = { sendRawHtml: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new ObservabilityService(prisma, mail);
    await svc.evaluateHttpAuditAlerts({
      ...base,
      path: '/api/<img src=x>',
      method: 'POST',
      statusCode: 403,
      success: false,
    });
    const html = mail.sendRawHtml.mock.calls[0][2];
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
