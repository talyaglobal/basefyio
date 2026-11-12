const auditCreate = jest.fn();
const userFindUnique = jest.fn();
jest.mock('@prisma/client', () => ({
  Prisma: {},
  PrismaClient: class {
    auditLog = { create: auditCreate };
    user = { findUnique: userFindUnique };
  },
}));

import { EventEmitter } from 'events';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import { AuditLogInterceptor } from './audit-log.interceptor';

function context(request: Record<string, unknown>, statusCode = 200, response?: any) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response ?? { statusCode },
    }),
  } as any;
}

/** A response that, like Express, only knows its final status once it is written. */
function liveResponse(initialStatus: number) {
  const res: any = new EventEmitter();
  res.statusCode = initialStatus;
  res.writableFinished = false;
  res.headersSent = false;
  res.finishWith = (status: number) => {
    res.statusCode = status;
    res.headersSent = true;
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
  };
  return res;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const ORIGINAL_READS = process.env.AUDIT_HTTP_READS;

beforeEach(() => {
  auditCreate.mockReset();
  auditCreate.mockResolvedValue({ id: 'row-1', createdAt: new Date('2026-10-20T10:00:00.000Z') });
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue({ role: 'USER' });
  delete process.env.AUDIT_HTTP_READS;
});

afterAll(() => {
  if (ORIGINAL_READS === undefined) delete process.env.AUDIT_HTTP_READS;
  else process.env.AUDIT_HTTP_READS = ORIGINAL_READS;
});

describe('AuditLogInterceptor → audit sink', () => {
  const user = { sub: 'user-1', roles: ['USER'] };

  it('forwards a successful request with the row id, method, path and status', async () => {
    process.env.AUDIT_HTTP_READS = 'all';
    const sink = { enqueue: jest.fn() };
    const interceptor = new AuditLogInterceptor(sink as any);
    const ctx = context({ method: 'GET', url: '/api/projects?x=1', user, traceId: 'tr-1' }, 200);

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of({ ok: true }) }));
    await flush();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(sink.enqueue).toHaveBeenCalledTimes(1);
    expect(sink.enqueue.mock.calls[0][0]).toMatchObject({
      id: 'row-1',
      time: '2026-10-20T10:00:00.000Z',
      source: 'http',
      traceId: 'tr-1',
      actorUserId: 'user-1',
      actorRole: 'USER',
      action: 'GET /api/projects',
      resourceType: 'projects',
      severity: 'LOW',
      success: true,
      method: 'GET',
      path: '/api/projects',
      statusCode: 200,
      product: 'basefyio',
    });
    expect(typeof sink.enqueue.mock.calls[0][0].latencyMs).toBe('number');
  });

  it('forwards a failed request with the status of the error, and re-throws it', async () => {
    const sink = { enqueue: jest.fn() };
    const interceptor = new AuditLogInterceptor(sink as any);
    // The response still holds the route default (200) when the handler throws.
    const ctx = context({ method: 'DELETE', url: '/api/teams/t1', user, traceId: 'tr-2' }, 200);

    await expect(
      lastValueFrom(
        interceptor.intercept(ctx, { handle: () => throwError(() => new ForbiddenException('nope')) }),
      ),
    ).rejects.toThrow('nope');
    await flush();

    expect(sink.enqueue.mock.calls[0][0]).toMatchObject({
      success: false,
      severity: 'HIGH',
      action: 'DELETE /api/teams/t1',
      statusCode: 403,
    });
  });

  it('still forwards when the database write fails, without a row id', async () => {
    auditCreate.mockRejectedValue(new Error('db down'));
    const sink = { enqueue: jest.fn() };
    const interceptor = new AuditLogInterceptor(sink as any);
    const ctx = context({ method: 'POST', url: '/api/x', user, traceId: 'tr-3' });

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(1) }));
    await flush();

    expect(sink.enqueue).toHaveBeenCalledTimes(1);
    expect(sink.enqueue.mock.calls[0][0].id).toBeUndefined();
  });

  it('a sink that throws never changes the response', async () => {
    const sink = {
      enqueue: jest.fn(() => {
        throw new Error('sink exploded');
      }),
    };
    const interceptor = new AuditLogInterceptor(sink as any);
    const ctx = context({ method: 'GET', url: '/api/x', user, traceId: 'tr-4' });

    await expect(lastValueFrom(interceptor.intercept(ctx, { handle: () => of('payload') }))).resolves.toBe(
      'payload',
    );
    await flush();
    expect(sink.enqueue).toHaveBeenCalled();
  });

  it('records key-authed callers with the project as actor', async () => {
    const sink = { enqueue: jest.fn() };
    const interceptor = new AuditLogInterceptor(sink as any);
    const ctx = context({
      method: 'POST',
      url: '/api/rest/v1/todos',
      apiKeyPayload: { projectId: 'p1', role: 'anon', dbRole: 'authenticated', jwtClaims: { sub: 'end-user' } },
      traceId: 'tr-5',
    });

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(1) }));
    await flush();

    expect(sink.enqueue.mock.calls[0][0]).toMatchObject({
      actorUserId: 'project:p1/user:end-user',
      actorRole: 'ANON_KEY_USER',
      projectId: 'p1',
    });
  });

  it('writes and forwards nothing for OPTIONS or anonymous requests', async () => {
    const sink = { enqueue: jest.fn() };
    const interceptor = new AuditLogInterceptor(sink as any);

    await lastValueFrom(
      interceptor.intercept(context({ method: 'OPTIONS', url: '/api/x', user, traceId: 't' }), { handle: () => of(1) }),
    );
    await lastValueFrom(
      interceptor.intercept(context({ method: 'GET', url: '/api/health', traceId: 't' }), { handle: () => of(1) }),
    );
    await flush();

    expect(auditCreate).not.toHaveBeenCalled();
    expect(sink.enqueue).not.toHaveBeenCalled();
  });

  it('works with no sink at all (the interceptor is constructed without one in tests)', async () => {
    const interceptor = new AuditLogInterceptor();
    await expect(
      lastValueFrom(interceptor.intercept(context({ method: 'PATCH', url: '/api/x', user, traceId: 't' }), { handle: () => of(1) })),
    ).resolves.toBe(1);
    await flush();
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });
});

describe('AuditLogInterceptor — the record matches what happened', () => {
  const user = { sub: 'user-1', roles: ['offline_access', 'default-roles-master'] };

  it('stores the status the client received, not the route default (404 on a GET)', async () => {
    const interceptor = new AuditLogInterceptor();
    const res = liveResponse(200);
    const ctx = context({ method: 'GET', url: '/api/projects/4769a207-960c-49a5-a59c-5a81762e5f1d', user, traceId: 't' }, 200, res);

    await expect(
      lastValueFrom(interceptor.intercept(ctx, { handle: () => throwError(() => new NotFoundException()) })),
    ).rejects.toBeInstanceOf(NotFoundException);
    await flush();
    expect(auditCreate).not.toHaveBeenCalled(); // waits for the response to be written

    res.finishWith(404);
    await flush();
    const data = auditCreate.mock.calls[0][0].data;
    expect(data.success).toBe(false);
    expect(data.metadataJson.statusCode).toBe(404);
    expect(data.afterJson.statusCode).toBe(404);
    // A failed read that was simply not found is not a high-severity event.
    expect(data.severity).toBe('LOW');
  });

  it('stores 500 for an unexpected error, never the 201 of a POST route', async () => {
    const interceptor = new AuditLogInterceptor();
    const res = liveResponse(201);
    const ctx = context({ method: 'POST', url: '/api/projects', user, traceId: 't' }, 201, res);

    await expect(
      lastValueFrom(interceptor.intercept(ctx, { handle: () => throwError(() => new Error('boom')) })),
    ).rejects.toThrow('boom');
    res.finishWith(500);
    await flush();
    expect(auditCreate.mock.calls[0][0].data.metadataJson.statusCode).toBe(500);
    expect(auditCreate.mock.calls[0][0].data.success).toBe(false);
  });

  it('a handler that answers 4xx itself is recorded as failed', async () => {
    const interceptor = new AuditLogInterceptor();
    const res = liveResponse(201);
    const ctx = context({ method: 'POST', url: '/api/projects/p/import', user, traceId: 't' }, 201, res);
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(undefined) }));
    res.finishWith(422);
    await flush();
    const data = auditCreate.mock.calls[0][0].data;
    expect(data.success).toBe(false);
    expect(data.metadataJson.statusCode).toBe(422);
  });

  it('resolves the platform role from the user row when the JWT has only Keycloak roles', async () => {
    userFindUnique.mockResolvedValue({ role: 'ROOT' });
    const interceptor = new AuditLogInterceptor();
    const ctx = context({ method: 'POST', url: '/api/teams', user: { sub: 'root-1', roles: ['offline_access'] }, traceId: 't' });
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of({ id: 'team-9' }) }));
    await flush();
    expect(auditCreate.mock.calls[0][0].data.actorRole).toBe('ROOT');
  });

  it('names the domain event, the resource, the caller and the fields changed', async () => {
    const interceptor = new AuditLogInterceptor();
    const ctx = context(
      {
        method: 'DELETE',
        url: '/api/projects/4769a207-960c-49a5-a59c-5a81762e5f1d/permanent',
        route: { path: '/api/projects/:id/permanent' },
        params: { id: '4769a207-960c-49a5-a59c-5a81762e5f1d' },
        user,
        traceId: 't',
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'Mozilla/5.0 test' },
      },
      200,
    );
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of({ status: 'deleting' }) }));
    await flush();
    const data = auditCreate.mock.calls[0][0].data;
    expect(data.severity).toBe('CRITICAL');
    expect(data.resourceType).toBe('project');
    expect(data.resourceId).toBe('4769a207-960c-49a5-a59c-5a81762e5f1d');
    expect(data.metadataJson).toMatchObject({
      event: 'project.deleted.permanent',
      projectId: '4769a207-960c-49a5-a59c-5a81762e5f1d',
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 test',
      authMethod: 'session',
    });
  });

  it('records the names of changed fields and only safe values', async () => {
    const interceptor = new AuditLogInterceptor();
    const ctx = context({
      method: 'PATCH',
      url: '/api/projects/4769a207-960c-49a5-a59c-5a81762e5f1d',
      route: { path: '/api/projects/:id' },
      params: { id: '4769a207-960c-49a5-a59c-5a81762e5f1d' },
      body: { description: 'new text', password: 'hunter2' },
      user,
      traceId: 't',
    });
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of({}) }));
    await flush();
    const after = auditCreate.mock.calls[0][0].data.afterJson;
    expect(after.event).toBe('project.updated');
    expect(after.fields).toEqual(['description', 'password']);
    expect(after.changes).toEqual({ description: 'new text' });
    expect(JSON.stringify(auditCreate.mock.calls[0][0].data)).not.toContain('hunter2');
  });

  it('keeps routine successful reads out of the table by default but still forwards them', async () => {
    const sink = { enqueue: jest.fn() };
    const interceptor = new AuditLogInterceptor(sink as any);
    await lastValueFrom(
      interceptor.intercept(context({ method: 'GET', url: '/api/project-folders', user, traceId: 't' }), { handle: () => of([]) }),
    );
    await flush();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(sink.enqueue).toHaveBeenCalledTimes(1);
  });

  it('raises alert evaluation for persisted rows', async () => {
    const observability = { evaluateHttpAuditAlerts: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AuditLogInterceptor(undefined, observability as any);
    const ctx = context({ method: 'POST', url: '/api/account/api-tokens/t1/roll', user, traceId: 't' });
    await expect(
      lastValueFrom(interceptor.intercept(ctx, { handle: () => throwError(() => new ForbiddenException()) })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await flush();
    expect(observability.evaluateHttpAuditAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ auditLogId: 'row-1', success: false, statusCode: 403, event: 'api_token.rolled' }),
    );
  });
});
