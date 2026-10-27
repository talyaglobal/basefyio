// The Keycloak admin client is ESM-only and Jest cannot load it; the Prisma
// client and the mailer are not needed here either. Only identities matter.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('../redis/redis.service', () => ({ RedisService: class {} }));
jest.mock('./project-auth-config.service', () => ({ ProjectAuthConfigService: class {} }));
jest.mock('./project-mfa.service', () => ({ ProjectMfaService: class {} }));
jest.mock('./imported-password.service', () => ({ ImportedPasswordService: class {} }));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ProjectSdkAuthService } from './project-sdk-auth.service';
import { ProjectAnonymousAuthService } from './project-anonymous-auth.service';

/**
 * Sign-in with and without a second factor, and the anonymous flows.
 *
 * The first test is the one that matters most: a user without an enrolled
 * factor must get exactly the response sign-in has always produced. Everything
 * new hangs off a row that no existing user has.
 */

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeJwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256', kid: 'k' })}.${b64url(claims)}.sig`;

const KC_TOKENS = {
  access_token: makeJwt({ sub: 'u1', email: 'ada@example.com' }),
  refresh_token: 'refresh-1',
  expires_in: 1800,
  token_type: 'Bearer',
};
const EXPECTED_TOKENS = {
  accessToken: KC_TOKENS.access_token,
  refreshToken: 'refresh-1',
  expiresIn: 1800,
  tokenType: 'Bearer',
};
const PROJECT = { id: 'p1', name: 'Shop', keycloakRealm: 'realm-p1', anonKey: 'bf_anon_x' };

const kcFailure = (error: string, description: string) => ({
  response: { data: { error, error_description: description } },
});

function build(o: {
  mfaState?: Record<string, unknown> | null;
  enforce?: boolean;
  kcUser?: Record<string, unknown> | null;
  post?: (url: string, body: string) => unknown;
  hasOtp?: boolean;
  allowAnonymous?: boolean;
  requireEmailVerify?: boolean;
  adopt?: boolean;
} = {}) {
  const prisma = { project: { findFirst: jest.fn().mockResolvedValue(PROJECT) } };
  const keycloak = {
    ensureRealmClientAuthTimeMapper: jest.fn().mockResolvedValue(undefined),
    ensureRealmClientDirectGrant: jest.fn().mockResolvedValue(true),
    findUserInRealm: jest
      .fn()
      .mockResolvedValue(o.kcUser === undefined ? { id: 'u1', email: 'ada@example.com', emailVerified: true } : o.kcUser),
    clearRealmUserLoginBlockers: jest.fn().mockResolvedValue(undefined),
    userHasOtpCredential: jest.fn().mockResolvedValue(o.hasOtp ?? false),
    isAnonymousUser: jest.fn((u: any) => u?.attributes?.is_anonymous?.[0] === 'true'),
    createAnonymousUser: jest.fn().mockResolvedValue('anon-uid'),
    ensureRealmClientAnonymousClaimMapper: jest.fn().mockResolvedValue(undefined),
    convertAnonymousUser: jest.fn().mockResolvedValue(undefined),
  };
  const http = {
    post: jest.fn((url: string, body: string) =>
      o.post ? (o.post(url, body) as any) : of({ data: KC_TOKENS }),
    ),
    get: jest.fn(),
  };
  const config = {
    get: (k: string) =>
      k === 'keycloak.url' ? 'http://kc:8080' : k === 'publicApiUrl' ? 'http://api.test' : undefined,
  };
  const cfg = {
    allowSignup: true,
    requireEmailVerify: o.requireEmailVerify ?? true,
    minPasswordLength: 6,
    mfaEnforceEnrollment: o.enforce ?? false,
    allowAnonymous: o.allowAnonymous ?? false,
  };
  const authConfig = { getOrCreate: jest.fn().mockResolvedValue(cfg), getRaw: jest.fn().mockResolvedValue(cfg) };
  const mfa = {
    getState: jest.fn().mockResolvedValue(o.mfaState ?? null),
    createChallenge: jest.fn().mockImplementation(async (_p, _r, _u, _t, kind) => ({
      mfaRequired: true,
      challengeId: 'challenge-1',
      methods: kind === 'verify' ? ['totp', 'recovery'] : ['totp'],
      expiresIn: 300,
      enrollmentRequired: kind === 'enroll',
    })),
    setEnrollmentRequired: jest.fn().mockResolvedValue(undefined),
    verifyChallenge: jest.fn(),
    peekChallenge: jest.fn(),
    consumeChallenge: jest.fn(),
    beginEnrollment: jest.fn(),
    confirmEnrollment: jest.fn(),
  };
  const redis = { set: jest.fn().mockResolvedValue(undefined), get: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() };
  const importedPasswords = {
    adoptOnSignIn: jest.fn().mockResolvedValue(o.adopt ?? false),
    settleForUser: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ProjectSdkAuthService(
    prisma as any, keycloak as any, {} as any, redis as any, http as any, config as any, authConfig as any, mfa as any,
    importedPasswords as any,
  );
  // Mail is not under test; keep it from touching the network.
  jest.spyOn(svc as any, 'sendEmail').mockResolvedValue(undefined);
  return { svc, prisma, keycloak, http, authConfig, mfa, redis, config, importedPasswords };
}

const grantBody = (http: { post: jest.Mock }, call = 0) => new URLSearchParams(http.post.mock.calls[call][1] as string);

describe('ProjectSdkAuthService.signin — second factor', () => {
  it('a user without a factor gets exactly the response sign-in always produced', async () => {
    const { svc, mfa } = build();
    const res = await svc.signin('p1', 'ada@example.com', 'pw', '203.0.113.9');
    expect(res).toEqual({ ...EXPECTED_TOKENS, userId: 'u1', emailVerified: true, mfaEnrollmentRequired: false });
    expect(mfa.getState).toHaveBeenCalledWith('p1', 'u1');
    expect(mfa.createChallenge).not.toHaveBeenCalled();
  });

  it('takes the user id from the token, not from a directory lookup that may miss', async () => {
    const { svc } = build({ kcUser: null });
    const res = await svc.signin('p1', 'ada@example.com', 'pw');
    expect(res).toMatchObject({ userId: 'u1', emailVerified: false });
  });

  it('an enrolled user gets a challenge and no tokens', async () => {
    const { svc, mfa } = build({ mfaState: { verifiedAt: new Date() } });
    const res: any = await svc.signin('p1', 'ada@example.com', 'pw');
    expect(res).toEqual({
      mfaRequired: true,
      challengeId: 'challenge-1',
      methods: ['totp', 'recovery'],
      expiresIn: 300,
      enrollmentRequired: false,
    });
    expect(res.accessToken).toBeUndefined();
    expect(mfa.createChallenge).toHaveBeenCalledWith(
      'p1', 'realm-p1', 'u1', EXPECTED_TOKENS, 'verify', { emailVerified: true, account: 'ada@example.com' },
    );
  });

  it('forwards totp to the password grant', async () => {
    const { svc, http } = build();
    await svc.signin('p1', 'ada@example.com', 'pw', undefined, '246810');
    expect(grantBody(http).get('totp')).toBe('246810');
    expect(grantBody(http).get('grant_type')).toBe('password');
  });

  it('does not send a totp parameter when none was given', async () => {
    const { svc, http } = build();
    await svc.signin('p1', 'ada@example.com', 'pw');
    expect(grantBody(http).has('totp')).toBe(false);
  });

  it('keeps an administrator\'s MFA request when the self-heal clears CONFIGURE_TOTP, and still signs the user in', async () => {
    let calls = 0;
    const { svc, mfa, keycloak } = build({
      kcUser: {
        id: 'u1',
        username: 'ada@example.com',
        email: 'ada@example.com',
        emailVerified: true,
        requiredActions: ['CONFIGURE_TOTP'],
        firstName: 'Ada',
        lastName: 'L',
      },
      mfaState: { enrollmentRequiredAt: new Date(), verifiedAt: null },
      post: () =>
        ++calls === 1
          ? throwError(() => kcFailure('invalid_grant', 'Account is not fully set up'))
          : of({ data: KC_TOKENS }),
    });
    const res: any = await svc.signin('p1', 'ada@example.com', 'pw');
    expect(mfa.setEnrollmentRequired).toHaveBeenCalledWith('p1', 'u1', true);
    expect(keycloak.clearRealmUserLoginBlockers).toHaveBeenCalledWith('realm-p1', 'u1');
    expect(mfa.setEnrollmentRequired.mock.invocationCallOrder[0]).toBeLessThan(
      keycloak.clearRealmUserLoginBlockers.mock.invocationCallOrder[0],
    );
    // Not enforced: today's behaviour, plus the flag for the app to prompt.
    expect(res).toMatchObject({ ...EXPECTED_TOKENS, userId: 'u1', mfaEnrollmentRequired: true });
  });

  it('with enforcement on, a flagged user without a factor gets an enrollment challenge instead of tokens', async () => {
    const { svc, mfa } = build({ mfaState: { enrollmentRequiredAt: new Date(), verifiedAt: null }, enforce: true });
    const res: any = await svc.signin('p1', 'ada@example.com', 'pw');
    expect(res).toMatchObject({ mfaRequired: true, enrollmentRequired: true, methods: ['totp'] });
    expect(res.accessToken).toBeUndefined();
    expect(mfa.createChallenge.mock.calls[0][4]).toBe('enroll');
  });

  it('an account with a Keycloak-side authenticator and no totp is told what is missing', async () => {
    const { svc } = build({
      hasOtp: true,
      post: () => throwError(() => kcFailure('invalid_grant', 'Invalid user credentials')),
    });
    const err = await svc.signin('p1', 'ada@example.com', 'pw').catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.getResponse()).toMatchObject({ code: 'totp_required' });
  });

  it('a plain wrong password is still "Invalid email or password"', async () => {
    const { svc, importedPasswords } = build({
      hasOtp: false,
      post: () => throwError(() => kcFailure('invalid_grant', 'Invalid user credentials')),
    });
    await expect(svc.signin('p1', 'ada@example.com', 'nope')).rejects.toThrow('Invalid email or password');
    expect(importedPasswords.adoptOnSignIn).toHaveBeenCalledWith('p1', 'realm-p1', 'ada@example.com', 'nope');
  });

  it('an imported user signs in with their old password: it is adopted, then the grant is retried', async () => {
    let calls = 0;
    const { svc, importedPasswords } = build({
      adopt: true,
      post: () =>
        calls++ === 0
          ? throwError(() => kcFailure('invalid_grant', 'Invalid user credentials'))
          : of({ data: KC_TOKENS }),
    });
    const res = await svc.signin('p1', 'ada@example.com', 'old-pw');
    expect(res).toMatchObject({ ...EXPECTED_TOKENS, userId: 'u1' });
    expect(importedPasswords.adoptOnSignIn).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it('a successful sign-in settles any imported hash still waiting for the user', async () => {
    const { svc, importedPasswords } = build();
    await svc.signin('p1', 'ada@example.com', 'pw');
    expect(importedPasswords.adoptOnSignIn).not.toHaveBeenCalled();
    expect(importedPasswords.settleForUser).toHaveBeenCalledWith('p1', 'u1');
  });

  it('a missing totp is never treated as an imported password', async () => {
    const { svc, importedPasswords } = build({
      hasOtp: true,
      post: () => throwError(() => kcFailure('invalid_grant', 'Invalid user credentials')),
    });
    await expect(svc.signin('p1', 'ada@example.com', 'pw')).rejects.toThrow(UnauthorizedException);
    // adoptOnSignIn only acts on a pending hash with no Keycloak password, which
    // an authenticator-holding account cannot be; calling it is harmless.
    expect(importedPasswords.adoptOnSignIn).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectSdkAuthService — MFA orchestration', () => {
  it('enrolls the signed-in user under the project name as issuer', async () => {
    const { svc, mfa } = build();
    mfa.beginEnrollment.mockResolvedValue({ secret: 'S' });
    await svc.beginMfaEnrollment('p1', { userId: 'u1', email: 'ada@example.com' });
    expect(mfa.beginEnrollment).toHaveBeenCalledWith('p1', 'u1', { issuer: 'Shop', account: 'ada@example.com' });
  });

  it('enrolls through an enrollment challenge and releases its tokens on confirmation', async () => {
    const { svc, mfa } = build();
    mfa.peekChallenge.mockResolvedValue({ kind: 'enroll', userId: 'u7', account: 'bob@example.com' });
    mfa.beginEnrollment.mockResolvedValue({ secret: 'S' });
    mfa.confirmEnrollment.mockResolvedValue({ enabled: true, recoveryCodes: ['A', 'B'] });
    mfa.consumeChallenge.mockResolvedValue({ tokens: EXPECTED_TOKENS, userId: 'u7', emailVerified: false });

    await svc.beginMfaEnrollment('p1', { challengeId: 'c-enroll' });
    expect(mfa.beginEnrollment).toHaveBeenCalledWith('p1', 'u7', { issuer: 'Shop', account: 'bob@example.com' });

    const res = await svc.confirmMfaEnrollment('p1', { challengeId: 'c-enroll' }, '123456');
    expect(mfa.confirmEnrollment).toHaveBeenCalledWith('p1', 'u7', '123456');
    expect(res).toEqual({ enabled: true, recoveryCodes: ['A', 'B'], ...EXPECTED_TOKENS, userId: 'u7', emailVerified: false });
  });

  it('refuses a verify challenge on the enrollment routes, and no actor at all', async () => {
    const { svc, mfa } = build();
    mfa.peekChallenge.mockResolvedValue({ kind: 'verify', userId: 'u1' });
    await expect(svc.beginMfaEnrollment('p1', { challengeId: 'c-verify' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.beginMfaEnrollment('p1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('revokes the parked Keycloak session when a challenge runs out of attempts', async () => {
    const { svc, mfa, http } = build();
    mfa.verifyChallenge.mockImplementation(async (_p: string, _c: string, _i: unknown, onExhausted: any) => {
      await onExhausted({ realm: 'realm-p1', tokens: { refreshToken: 'refresh-1' } });
      return 'done';
    });
    await svc.completeMfaChallenge('p1', 'c1', { code: '000000' });
    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('http://kc:8080/realms/realm-p1/protocol/openid-connect/logout');
    expect(new URLSearchParams(body as string).get('refresh_token')).toBe('refresh-1');
    expect(new URLSearchParams(body as string).get('client_id')).toBe('realm-p1-anon');
  });
});

describe('ProjectSdkAuthService — anonymous identities and mail', () => {
  it('does not try to mail an anonymous identity, and answers as for an unknown address', async () => {
    const { svc, redis } = build({
      kcUser: { id: 'anon-1', email: 'anon_x@anonymous.invalid', attributes: { is_anonymous: ['true'] } },
    });
    await expect(svc.forgotPassword('p1', 'anon_x@anonymous.invalid')).resolves.toEqual({
      message: 'If an account exists, a reset code has been sent',
    });
    await expect(svc.sendMagicLink('p1', 'anon_x@anonymous.invalid')).resolves.toEqual({
      message: 'If an account exists, a magic link has been sent',
    });
    expect(redis.set).not.toHaveBeenCalled();
  });
});

describe('ProjectAnonymousAuthService', () => {
  class FakeRedis {
    store = new Map<string, number>();
    async incr(key: string) {
      const n = (this.store.get(key) ?? 0) + 1;
      this.store.set(key, n);
      return n;
    }
    async expire() {}
  }

  function anon(o: { allowAnonymous?: boolean; requireEmailVerify?: boolean; config?: Record<string, unknown>; existing?: any } = {}) {
    const base = build({ allowAnonymous: o.allowAnonymous, requireEmailVerify: o.requireEmailVerify });
    if (o.existing !== undefined) base.keycloak.findUserInRealm.mockResolvedValue(o.existing);
    const sdkAuth = {
      getProject: jest.fn().mockResolvedValue(PROJECT),
      authenticateInRealm: jest.fn().mockResolvedValue(EXPECTED_TOKENS),
      issueEmailVerification: jest.fn().mockResolvedValue(undefined),
    };
    const redis = new FakeRedis();
    const config = { get: (k: string) => o.config?.[k] };
    const svc = new ProjectAnonymousAuthService(
      base.keycloak as any, redis as any, config as any, base.authConfig as any, sdkAuth as any,
    );
    return { svc, sdkAuth, keycloak: base.keycloak, redis };
  }

  it('is off unless the project allows it, and then never touches Keycloak', async () => {
    const { svc, keycloak } = anon({ allowAnonymous: false });
    await expect(svc.signInAnonymously('p1', '203.0.113.9')).rejects.toBeInstanceOf(ForbiddenException);
    expect(keycloak.createAnonymousUser).not.toHaveBeenCalled();
  });

  it('creates a marked throw-away user, installs the claim mapper and mints tokens with a one-use password', async () => {
    const { svc, keycloak, sdkAuth } = anon({ allowAnonymous: true });
    const res = await svc.signInAnonymously('p1', '203.0.113.9');

    const [realm, username, password] = keycloak.createAnonymousUser.mock.calls[0];
    expect(realm).toBe('realm-p1');
    expect(username).toMatch(/^anon_[0-9a-f]{24}$/);
    expect(typeof password).toBe('string');
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(keycloak.ensureRealmClientAnonymousClaimMapper).toHaveBeenCalledWith('realm-p1', 'realm-p1-anon');
    expect(sdkAuth.authenticateInRealm).toHaveBeenCalledWith('realm-p1', 'realm-p1-anon', username, password, false, '203.0.113.9');
    expect(res).toEqual({ ...EXPECTED_TOKENS, userId: 'anon-uid', emailVerified: false, isAnonymous: true });
  });

  it('limits how many anonymous users one address may create per hour', async () => {
    const { svc } = anon({ allowAnonymous: true, config: { ANON_SIGNIN_PER_IP_HOURLY: '2' } });
    await svc.signInAnonymously('p1', '203.0.113.9');
    await svc.signInAnonymously('p1', '203.0.113.9');
    const err = await svc.signInAnonymously('p1', '203.0.113.9').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    // A different address is unaffected.
    await expect(svc.signInAnonymously('p1', '198.51.100.2')).resolves.toMatchObject({ isAnonymous: true });
  });

  it('upgrade needs an anonymous session, a free email and an acceptable password', async () => {
    const { svc } = anon({ allowAnonymous: true, existing: { id: 'someone-else', email: 'ada@example.com' } });
    const anonClaims = { sub: 'anon-uid', is_anonymous: true };
    await expect(
      svc.upgradeAnonymous('p1', { sub: 'u1' }, { email: 'ada@example.com', password: 'secret12' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.upgradeAnonymous('p1', anonClaims, { email: 'not-an-email', password: 'secret12' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.upgradeAnonymous('p1', anonClaims, { email: 'ada@example.com', password: 'abc' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.upgradeAnonymous('p1', anonClaims, { email: 'ada@example.com', password: 'secret12' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('converts the user in place, sends verification when the project requires it, and returns fresh tokens', async () => {
    const { svc, keycloak, sdkAuth } = anon({ allowAnonymous: true, requireEmailVerify: true, existing: null });
    const res = await svc.upgradeAnonymous(
      'p1',
      { sub: 'anon-uid', is_anonymous: true },
      { email: 'Ada@Example.com', password: 'secret12', firstName: 'Ada' },
      '203.0.113.9',
    );
    expect(keycloak.convertAnonymousUser).toHaveBeenCalledWith('realm-p1', 'anon-uid', {
      email: 'ada@example.com',
      password: 'secret12',
      firstName: 'Ada',
      lastName: undefined,
      emailVerified: false,
    });
    expect(sdkAuth.issueEmailVerification).toHaveBeenCalledWith(PROJECT, 'anon-uid', 'ada@example.com');
    expect(sdkAuth.authenticateInRealm).toHaveBeenCalledWith(
      'realm-p1', 'realm-p1-anon', 'ada@example.com', 'secret12', false, '203.0.113.9', { projectId: 'p1' },
    );
    expect(res).toEqual({ ...EXPECTED_TOKENS, userId: 'anon-uid', emailVerified: false, isAnonymous: false });
  });

  it('skips verification mail when the project does not require it', async () => {
    const { svc, sdkAuth, keycloak } = anon({ allowAnonymous: true, requireEmailVerify: false, existing: null });
    const res = await svc.upgradeAnonymous('p1', { sub: 'anon-uid', is_anonymous: 'true' }, { email: 'ada@example.com', password: 'secret12' });
    expect(keycloak.convertAnonymousUser.mock.calls[0][2].emailVerified).toBe(true);
    expect(sdkAuth.issueEmailVerification).not.toHaveBeenCalled();
    expect(res.emailVerified).toBe(true);
  });
});
