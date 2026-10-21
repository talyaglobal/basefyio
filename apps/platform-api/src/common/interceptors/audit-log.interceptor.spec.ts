const auditCreate = jest.fn();
jest.mock('@prisma/client', () => ({
  Prisma: {},
  PrismaClient: class {
    auditLog = { create: auditCreate };
  },
}));

import { of, throwError, lastValueFrom } from 'rxjs';
import { AuditLogInterceptor } from './audit-log.interceptor';

function context(request: Record<string, unknown>, statusCode = 200) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode }),
    }),
  } as any;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  auditCreate.mockReset();
  auditCreate.mockResolvedValue({ id: 'row-1', createdAt: new Date('2026-10-20T10:00:00.000Z') });
});

describe('AuditLogInterceptor → audit sink', () => {
  const user = { sub: 'user-1', roles: ['USER'] };

  it('forwards a successful request with the row id, method, path and status', async () => {
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

  it('forwards a failed request and re-throws the error', async () => {
    const sink = { enqueue: jest.fn() };
    const interceptor = new AuditLogInterceptor(sink as any);
    const ctx = context({ method: 'DELETE', url: '/api/teams/t1', user, traceId: 'tr-2' }, 403);

    await expect(
      lastValueFrom(interceptor.intercept(ctx, { handle: () => throwError(() => new Error('nope')) })),
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
    const ctx = context({ method: 'GET', url: '/api/x', user, traceId: 'tr-3' });

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
      lastValueFrom(interceptor.intercept(context({ method: 'GET', url: '/api/x', user, traceId: 't' }), { handle: () => of(1) })),
    ).resolves.toBe(1);
    await flush();
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });
});
