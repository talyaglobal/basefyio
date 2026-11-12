/**
 * Root console › Users: the search is plain text (no LIKE wildcards), and
 * using a session marks the user as recently active.
 */
jest.mock('minio', () => ({ Client: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('../billing/billing.service', () => ({ BillingService: class {} }));
jest.mock('../redis/redis.service', () => ({ RedisService: class {} }));
jest.mock('./keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('./platform-mfa.service', () => ({ PlatformMfaService: class {} }), { virtual: true });

import { of } from 'rxjs';
import { AuthService } from './auth.service';

const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');

function build() {
  const prisma = {
    user: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    loginSecurityState: { findMany: jest.fn(async () => []) },
  };
  const config = {
    get: (k: string) =>
      ({ 'keycloak.url': 'http://kc', 'keycloak.adminClientId': 'admin-cli' } as Record<string, string>)[k],
  };
  const http = {
    post: jest.fn(() =>
      of({ data: { access_token: `h.${payload}.s`, refresh_token: 'r2', expires_in: 300 } }),
    ),
  };
  const keycloak = { getPlatformOAuthClientId: () => 'platform' };
  const ctorArgs: any[] = [config, http, keycloak, prisma, {}, {}, {}, {}];
  const svc: AuthService = new (AuthService as any)(...ctorArgs);
  return { svc, prisma };
}

describe('AuthService.listManagementUsersPage — search', () => {
  it.each([
    ['%', '\\%'],
    ['_', '\\_'],
    ['a%z', 'a\\%z'],
  ])('searches %p as plain text', async (q, expected) => {
    const { svc, prisma } = build();
    await svc.listManagementUsersPage({ page: 1, pageSize: 20, q });
    const where = (prisma.user.findMany.mock.calls[0] as any[])[0].where;
    expect(where.OR).toEqual([
      { email: { contains: expected, mode: 'insensitive' } },
      { firstName: { contains: expected, mode: 'insensitive' } },
      { lastName: { contains: expected, mode: 'insensitive' } },
    ]);
    // The total uses the same filter.
    expect((prisma.user.count.mock.calls[0] as any[])[0].where).toEqual(where);
  });

  it('lists everyone for an empty or blank query', async () => {
    const { svc, prisma } = build();
    await svc.listManagementUsersPage({ page: 1, pageSize: 20, q: '   ' });
    expect((prisma.user.findMany.mock.calls[0] as any[])[0].where).toEqual({});
  });
});

describe('AuthService — session activity', () => {
  it('marks the user as seen on a token refresh, at most once an hour', async () => {
    const { svc, prisma } = build();
    await svc.refresh('r1');
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const args = (prisma.user.updateMany.mock.calls[0] as any[])[0];
    expect(args.where.id).toBe('u1');
    expect(args.where.OR).toEqual([{ lastSeenAt: null }, { lastSeenAt: { lt: expect.any(Date) } }]);
    expect(Object.keys(args.data)).toEqual(['lastSeenAt']);
  });

  it('never fails the refresh when the activity write fails', async () => {
    const { svc, prisma } = build();
    prisma.user.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.refresh('r1')).resolves.toMatchObject({ refreshToken: 'r2' });
  });
});
