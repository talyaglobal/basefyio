import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { FrozenAccountInterceptor, isFrozenAllowedPath } from './frozen-account.interceptor';

function makeContext(request: Record<string, unknown>) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

function makeInterceptor(status: string | null) {
  const findUnique = jest.fn(async () => (status === null ? null : { activeTeam: { accountStatus: status } }));
  const prisma = { user: { findUnique } } as any;
  return { interceptor: new FrozenAccountInterceptor(prisma), findUnique };
}

const next = { handle: () => of('ok') };

describe('FrozenAccountInterceptor', () => {
  it('lets requests without a dashboard user through without asking the database', async () => {
    const { interceptor, findUnique } = makeInterceptor('FROZEN');
    await interceptor.intercept(makeContext({ path: '/api/projects' }), next);
    await interceptor.intercept(makeContext({ path: '/api/rest/v1/t', user: { sub: 'u1' }, apiKeyPayload: { projectId: 'p' } }), next);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('keeps the shell and billing reachable for a frozen account', async () => {
    const { interceptor, findUnique } = makeInterceptor('FROZEN');
    for (const path of ['/api/auth/profile', '/api/billing/subscription', '/api/teams', '/api/teams/active', '/api/features', '/api/organizations/x']) {
      await interceptor.intercept(makeContext({ path, user: { sub: 'u1' } }), next);
    }
    expect(findUnique).not.toHaveBeenCalled();
    expect(isFrozenAllowedPath('/api/teamsx')).toBe(false);
  });

  it('refuses everything else for a frozen account, with the code the dashboard knows', async () => {
    const { interceptor } = makeInterceptor('FROZEN');
    await expect(interceptor.intercept(makeContext({ path: '/api/projects', user: { sub: 'u1' } }), next)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_FROZEN' },
    });
    await expect(interceptor.intercept(makeContext({ path: '/api/sql/execute', user: { sub: 'u1' } }), next)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('passes an active account and asks the database once per minute', async () => {
    const { interceptor, findUnique } = makeInterceptor('ACTIVE');
    const ctx = makeContext({ path: '/api/projects', user: { sub: 'u2' } });
    await interceptor.intercept(ctx, next);
    await interceptor.intercept(ctx, next);
    await interceptor.intercept(makeContext({ path: '/api/storage/x', user: { sub: 'u2' } }), next);
    expect(findUnique).toHaveBeenCalledTimes(1);
    interceptor.forget('u2');
    await interceptor.intercept(ctx, next);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('never locks anyone out when the database cannot answer', async () => {
    const prisma = { user: { findUnique: jest.fn(async () => { throw new Error('down'); }) } } as any;
    const interceptor = new FrozenAccountInterceptor(prisma);
    await expect(interceptor.intercept(makeContext({ path: '/api/projects', user: { sub: 'u3' } }), next)).resolves.toBeDefined();
  });
});
