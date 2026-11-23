/**
 * #196: dashboard sign-in applies two-factor authentication. The common path
 * (no authenticator, no team policy) is pinned by auth.service.login-regression.spec.ts;
 * this file covers the accounts it does concern, with the real PlatformMfaService.
 */
jest.mock('minio', () => ({ Client: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('../billing/billing.service', () => ({ BillingService: class {} }));
jest.mock('../redis/redis.service', () => ({ RedisService: class {} }));
jest.mock('./keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../organizations/organizations-core.service', () => ({ OrganizationsCoreService: class {} }));

import { of } from 'rxjs';
import { AuthService } from './auth.service';
import { CONFIGURE_TOTP, PlatformMfaService } from './platform-mfa.service';

const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');
const TOKENS = { access_token: `h.${payload}.s`, refresh_token: 'r1', id_token: 'i1', expires_in: 300, token_type: 'Bearer' };

const config = {
  get: (k: string) =>
    ((
      {
        'keycloak.url': 'http://kc',
        'keycloak.publicUrl': 'https://auth.example',
        'keycloak.adminClientId': 'admin-cli',
        publicApiUrl: 'https://api.example',
      } as Record<string, string>
    )[k]),
};

function build(opts: {
  hasOtp?: boolean;
  requiredBy?: string[];
  grant?: 'ok' | 'wrong' | 'not-set-up';
  pendingSetup?: boolean;
}) {
  const requiredBy = opts.requiredBy ?? [];
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'u1',
        email: 'a@b.c',
        mfaEnrolledAt: opts.hasOtp ? new Date() : null,
        teamMembers: requiredBy.map((name) => ({ team: { name } })),
        notifySignIn: false,
        notifySignInNewDevice: false,
        lastLoginFingerprint: null,
      })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    loginSecurityState: {
      upsert: jest.fn(async () => ({ consecutiveFailed: 0, lockedUntil: null })),
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({ failedAttempts: 0, consecutiveFailed: 0 })),
    },
  };
  const keycloak = {
    getPlatformUserEnabledById: jest.fn(async () => true),
    getPlatformUserSignInMethodsById: jest.fn(async () => ({ signOnMethod: 'local', hasPasswordAuth: true })),
    getPlatformUserForcePasswordChangeById: jest.fn(async () => false),
    userHasOtpCredential: jest.fn(async () => !!opts.hasOtp),
    userHasRequiredAction: jest.fn(async () => !!opts.pendingSetup),
    setUserRequiredAction: jest.fn(async () => undefined),
    removeUserRequiredAction: jest.fn(async () => undefined),
    getPlatformOAuthClientId: () => 'basefyio-dashboard',
    getPlatformUsername: jest.fn(async () => 'a@b.c'),
    findPlatformUserByEmail: jest.fn(async () => ({ id: 'u1' })),
  };
  const http = {
    post: jest.fn(() => {
      if (opts.grant === 'wrong') {
        throw { response: { status: 401, data: { error: 'invalid_grant', error_description: 'Invalid user credentials' } } };
      }
      if (opts.grant === 'not-set-up') {
        throw { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Account is not fully set up' } } };
      }
      return of({ data: TOKENS });
    }),
  };
  const email = { sendSignInNotification: jest.fn(() => Promise.resolve()), sendRawHtml: jest.fn(() => Promise.resolve()) };
  const mfa = new PlatformMfaService(config as any, http as any, keycloak as any, prisma as any, email as any);
  const svc: AuthService = new (AuthService as any)(config, http, keycloak, prisma, email, {}, {}, {}, mfa);
  return { svc, prisma, keycloak, http };
}

const sentBody = (http: { post: jest.Mock }) => new URLSearchParams(http.post.mock.calls[0][1] as string);

describe('AuthService.login with two-factor authentication (#196)', () => {
  it('asks for the code before the grant when the account has an authenticator, and counts no failure', async () => {
    const { svc, http, prisma } = build({ hasOtp: true });
    await expect(svc.login('a@b.c', 'pw')).rejects.toMatchObject({ response: { code: 'MFA_REQUIRED' } });
    expect(http.post).not.toHaveBeenCalled();
    expect(prisma.loginSecurityState.findUnique).not.toHaveBeenCalled();
  });

  it('sends the code to Keycloak and signs in', async () => {
    const { svc, http } = build({ hasOtp: true });
    const r = await svc.login('a@b.c', 'pw', undefined, undefined, ' 123 456 ');
    expect(sentBody(http).get('totp')).toBe('123456');
    expect(r.accessToken).toBe(TOKENS.access_token);
  });

  it('a wrong code is an ordinary failed sign-in', async () => {
    const { svc, prisma } = build({ hasOtp: true, grant: 'wrong' });
    await expect(svc.login('a@b.c', 'pw', undefined, undefined, '000000')).rejects.toThrow('Invalid credentials');
    expect(prisma.loginSecurityState.findUnique).toHaveBeenCalled();
  });

  it('a member of a team that requires it, with no authenticator, gets no tokens and the setup link', async () => {
    const { svc, keycloak, prisma } = build({ requiredBy: ['Acme'] });
    const err: any = await svc.login('a@b.c', 'pw').catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
    expect(err.getResponse().details.enrollUrl).toContain('kc_action=CONFIGURE_TOTP');
    expect(err.getResponse().message).toContain('Acme');
    expect(keycloak.setUserRequiredAction).toHaveBeenCalledWith('master', 'u1', CONFIGURE_TOTP, true);
    // The password was right: not a failed attempt, and no sign-in recorded either.
    expect(prisma.loginSecurityState.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a pending setup on a member who must enrol sends them to the setup page', async () => {
    const { svc } = build({ requiredBy: ['Acme'], grant: 'not-set-up', pendingSetup: true });
    await expect(svc.login('a@b.c', 'pw')).rejects.toMatchObject({ response: { code: 'MFA_ENROLLMENT_REQUIRED' } });
  });

  it('a pending setup nobody requires any more is released and the grant retried', async () => {
    const { svc, keycloak, http } = build({ grant: 'not-set-up', pendingSetup: true });
    // The retry fails the same way in this stub, which is what a stuck account would see.
    await expect(svc.login('a@b.c', 'pw')).rejects.toThrow('Invalid credentials');
    expect(keycloak.removeUserRequiredAction).toHaveBeenCalledWith('master', 'u1', CONFIGURE_TOTP);
    expect(http.post).toHaveBeenCalledTimes(2);
  });
});

describe('AuthService.handleOAuthCallback with a team two-factor policy (#196)', () => {
  const webState = Buffer.from(JSON.stringify({ redirectTo: '/login' })).toString('base64url');

  function oauth(requiredBy: string[], hasOtp = false) {
    const b = build({ requiredBy, hasOtp });
    const redis = { getdel: jest.fn(async () => null) };
    const mfa = new PlatformMfaService(config as any, b.http as any, b.keycloak as any, b.prisma as any, {
      sendRawHtml: jest.fn(() => Promise.resolve()),
    } as any);
    const svc: AuthService = new (AuthService as any)(config, b.http, b.keycloak, b.prisma, {}, {}, redis, {}, mfa);
    return { ...b, svc };
  }

  it('sends a required member without an authenticator to setup instead of handing out tokens', async () => {
    const { svc } = oauth(['Acme']);
    const r: any = await svc.handleOAuthCallback('code', webState);
    expect(r.mfaEnrollUrl).toContain('kc_action=CONFIGURE_TOTP');
    expect(r.accessToken).toBeUndefined();
  });

  it('hands out tokens as before when no team requires it', async () => {
    const { svc } = oauth([]);
    const r: any = await svc.handleOAuthCallback('code', webState);
    expect(r.accessToken).toBe(TOKENS.access_token);
    expect(r.mfaEnrollUrl).toBeUndefined();
  });
});
