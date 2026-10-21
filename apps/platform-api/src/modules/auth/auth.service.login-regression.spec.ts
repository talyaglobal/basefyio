/**
 * Pins the dashboard login hot path for an account that is neither enrolled in
 * two-factor authentication nor a member of a team that requires it.
 *
 * Every call the service makes is recorded in order. The two-factor work adds
 * fields to the first `user.findUnique` select and nothing else: no extra
 * query, no Keycloak credential lookup, no change to the token request body or
 * to the response shape. If this spec goes red, the common path changed.
 */
jest.mock('minio', () => ({ Client: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('../billing/billing.service', () => ({ BillingService: class {} }));
jest.mock('../redis/redis.service', () => ({ RedisService: class {} }));
jest.mock('./keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('./platform-mfa.service', () => ({ PlatformMfaService: class {} }), { virtual: true });

import { UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { AuthService } from './auth.service';

const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');
const TOKENS = {
  access_token: `h.${payload}.s`,
  refresh_token: 'r1',
  id_token: 'i1',
  expires_in: 300,
  token_type: 'Bearer',
};

const config = {
  get: (k: string) =>
    ({ 'keycloak.url': 'http://kc', 'keycloak.adminClientId': 'admin-cli' } as Record<string, string>)[k],
};

function build(opts: { grantFails?: boolean } = {}) {
  const calls: string[] = [];
  let userLookups = 0;
  const prisma = {
    user: {
      findUnique: jest.fn(async (args: any) => {
        calls.push('prisma.user.findUnique');
        userLookups += 1;
        if (userLookups === 1) {
          // Answer whatever the first select asks for; today's code reads only `id`.
          return { id: 'u1', mfaEnrolledAt: null, teamMembers: [] };
        }
        return {
          id: 'u1',
          email: args.where.email,
          firstName: 'A',
          lastName: 'B',
          notifySignIn: false,
          notifySignInNewDevice: false,
          lastLoginFingerprint: null,
        };
      }),
      update: jest.fn(async () => {
        calls.push('prisma.user.update');
        return {};
      }),
    },
    loginSecurityState: {
      upsert: jest.fn(async () => {
        calls.push('prisma.loginSecurityState.upsert');
        return { consecutiveFailed: 0, lockedUntil: null };
      }),
      update: jest.fn(async () => {
        calls.push('prisma.loginSecurityState.update');
        return {};
      }),
      findUnique: jest.fn(async () => {
        calls.push('prisma.loginSecurityState.findUnique');
        return { failedAttempts: 0, consecutiveFailed: 0 };
      }),
    },
  };
  const keycloak = {
    getPlatformUserEnabledById: jest.fn(async () => {
      calls.push('keycloak.getPlatformUserEnabledById');
      return true;
    }),
    getPlatformUserSignInMethodsById: jest.fn(async () => {
      calls.push('keycloak.getPlatformUserSignInMethodsById');
      return { authProvider: 'local', signOnMethod: 'local', linkedProviders: [], hasPasswordAuth: true };
    }),
    getPlatformUserForcePasswordChangeById: jest.fn(async () => {
      calls.push('keycloak.getPlatformUserForcePasswordChangeById');
      return false;
    }),
    getUserCredentials: jest.fn(async () => {
      calls.push('keycloak.getUserCredentials');
      return [];
    }),
    setUserRequiredAction: jest.fn(async () => {
      calls.push('keycloak.setUserRequiredAction');
    }),
  };
  const http = {
    post: jest.fn(() => {
      calls.push('http.post');
      if (opts.grantFails) {
        throw Object.assign(new Error('401'), {
          response: { status: 401, data: { error: 'invalid_grant', error_description: 'Invalid user credentials' } },
        });
      }
      return of({ data: TOKENS });
    }),
  };
  const email = { sendSignInNotification: jest.fn(() => Promise.resolve()) };
  const mfa = {
    resolveLoginMfa: jest.fn(async () => ({ hasOtp: false, required: false })),
  };
  // Constructed through `any` so the spec compiles against both the constructor
  // before the two-factor work (7 parameters) and after it (8).
  const ctorArgs: any[] = [config, http, keycloak, prisma, email, {}, {}, mfa];
  const svc: AuthService = new (AuthService as any)(...ctorArgs);
  return { svc, calls, prisma, keycloak, http, email };
}

describe('AuthService.login — common path (no two-factor involved)', () => {
  it('makes exactly today\'s sequence of calls and returns today\'s shape', async () => {
    const { svc, calls, prisma, http } = build();

    const result = await svc.login('User@Example.com', 'pw', { ipAddress: '1.2.3.4', userAgent: 'ua' });

    expect(calls).toEqual([
      'prisma.user.findUnique',
      'keycloak.getPlatformUserEnabledById',
      'keycloak.getPlatformUserSignInMethodsById',
      'prisma.loginSecurityState.upsert',
      'http.post',
      'prisma.user.findUnique',
      'prisma.user.update',
      'prisma.loginSecurityState.update',
      'keycloak.getPlatformUserForcePasswordChangeById',
    ]);

    // The first lookup is by normalised email and still asks for the id.
    const first = prisma.user.findUnique.mock.calls[0][0];
    expect(first.where).toEqual({ email: 'user@example.com' });
    expect(first.select.id).toBe(true);

    // The token request is byte-identical to today's.
    const [url, body, options] = http.post.mock.calls[0] as unknown as [string, string, any];
    expect(url).toBe('http://kc/realms/master/protocol/openid-connect/token');
    expect(body).toBe(
      new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'User@Example.com',
        password: 'pw',
      }).toString(),
    );
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    expect(result).toEqual({
      accessToken: TOKENS.access_token,
      refreshToken: 'r1',
      idToken: 'i1',
      expiresIn: 300,
      tokenType: 'Bearer',
      forcePasswordChange: false,
    });
  });

  it('never consults Keycloak credentials or required actions on the common path', async () => {
    const { svc, keycloak } = build();
    await svc.login('user@example.com', 'pw');
    expect(keycloak.getUserCredentials).not.toHaveBeenCalled();
    expect(keycloak.setUserRequiredAction).not.toHaveBeenCalled();
  });

  it('a wrong password still registers one failure and answers "Invalid credentials"', async () => {
    const { svc, calls, keycloak } = build({ grantFails: true });

    await expect(svc.login('user@example.com', 'nope')).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );

    expect(calls).toEqual([
      'prisma.user.findUnique',
      'keycloak.getPlatformUserEnabledById',
      'keycloak.getPlatformUserSignInMethodsById',
      'prisma.loginSecurityState.upsert',
      'http.post',
      'prisma.loginSecurityState.findUnique',
      'prisma.loginSecurityState.update',
    ]);
    expect(keycloak.getUserCredentials).not.toHaveBeenCalled();
  });
});
