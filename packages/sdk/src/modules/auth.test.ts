import { describe, expect, it, vi } from 'vitest';
import { AuthClient } from './auth';

/**
 * The second factor and anonymous sessions from the SDK's side.
 *
 * `signIn` keeps its `data`/`error` contract: a challenge shows up as a
 * sign-in that produced no session, with `mfa` carrying what the app needs to
 * finish it. Nothing here talks to the network; `http.json` is a stub that
 * records calls.
 */

interface Sent {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
}

function fakeHttp(responses: Record<string, unknown>) {
  const sent: Sent[] = [];
  const json = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    sent.push({ path, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (!(path in responses)) throw { message: `no stub for ${path}`, status: 404 };
    const value = responses[path];
    if (value && typeof value === 'object' && 'throws' in (value as Record<string, unknown>)) {
      throw (value as { throws: unknown }).throws;
    }
    return value;
  });
  return { http: { json } as never, sent };
}

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;

const TOKENS = { accessToken: jwt({ sub: 'u1' }), refreshToken: 'r1', expiresIn: 1800, tokenType: 'Bearer', userId: 'u1' };
const CHALLENGE = { mfaRequired: true, challengeId: 'ch-1', methods: ['totp', 'recovery'], expiresIn: 300, enrollmentRequired: false };

describe('AuthClient.signIn', () => {
  it('still sets the session and returns tokens when no second factor is involved', async () => {
    const { http } = fakeHttp({ '/rest/v1/auth/signin': TOKENS, '/rest/v1/auth/me': { sub: 'u1' } });
    const auth = new AuthClient(http, false);
    const res = await auth.signIn({ email: 'a@b.c', password: 'pw' });
    expect(res.data).toEqual(TOKENS);
    expect(res.error).toBeNull();
    expect(res.mfa).toBeNull();
    expect(auth.getAccessToken()).toBe(TOKENS.accessToken);
  });

  it('returns the challenge in `mfa` and no session when the account has an authenticator', async () => {
    const { http } = fakeHttp({ '/rest/v1/auth/signin': CHALLENGE });
    const auth = new AuthClient(http, false);
    const res = await auth.signIn({ email: 'a@b.c', password: 'pw' });
    expect(res.data).toBeNull();
    expect(res.error).toEqual({ message: 'Multi-factor authentication required', code: 'mfa_required' });
    expect(res.mfa).toEqual({ challengeId: 'ch-1', methods: ['totp', 'recovery'], expiresIn: 300, enrollmentRequired: false });
    expect(auth.getSession()).toBeNull();
  });

  it('sends totp along with the credentials when given', async () => {
    const { http, sent } = fakeHttp({ '/rest/v1/auth/signin': TOKENS, '/rest/v1/auth/me': {} });
    await new AuthClient(http, false).signIn({ email: 'a@b.c', password: 'pw', totp: '123456' });
    expect(sent[0].body).toEqual({ email: 'a@b.c', password: 'pw', totp: '123456' });
  });

  it('passes the server\'s error code through', async () => {
    const { http } = fakeHttp({
      '/rest/v1/auth/signin': { throws: { message: 'needs code', status: 401, code: 'totp_required' } },
    });
    const res = await new AuthClient(http, false).signIn({ email: 'a@b.c', password: 'pw' });
    expect(res.error).toEqual({ message: 'needs code', status: 401, code: 'totp_required' });
    expect(res.mfa).toBeNull();
  });
});

describe('AuthClient — completing and managing MFA', () => {
  it('verifyMfa posts the challenge and code, then starts the session', async () => {
    const { http, sent } = fakeHttp({ '/rest/v1/auth/mfa/challenge': TOKENS, '/rest/v1/auth/me': {} });
    const auth = new AuthClient(http, false);
    const res = await auth.verifyMfa('ch-1', '654321');
    expect(sent[0]).toEqual({ path: '/rest/v1/auth/mfa/challenge', method: 'POST', body: { challengeId: 'ch-1', code: '654321' } });
    expect(res.data).toEqual(TOKENS);
    expect(auth.getAccessToken()).toBe(TOKENS.accessToken);
  });

  it('verifyMfa with { recovery: true } sends a recovery code instead', async () => {
    const { http, sent } = fakeHttp({ '/rest/v1/auth/mfa/challenge': TOKENS, '/rest/v1/auth/me': {} });
    await new AuthClient(http, false).verifyMfa('ch-1', 'ABCDE-FGHJK', { recovery: true });
    expect(sent[0].body).toEqual({ challengeId: 'ch-1', recoveryCode: 'ABCDE-FGHJK' });
  });

  it('enrollMfa includes the challenge id when enrollment is required at sign-in', async () => {
    const enrollment = { secret: 'S', otpauthUrl: 'otpauth://totp/x', issuer: 'Shop', account: 'a@b.c', algorithm: 'SHA1', digits: 6, period: 30 };
    const { http, sent } = fakeHttp({ '/rest/v1/auth/mfa/enroll': enrollment });
    const auth = new AuthClient(http, false);
    expect((await auth.enrollMfa()).data).toEqual(enrollment);
    expect(sent[0].body).toEqual({});
    await auth.enrollMfa({ challengeId: 'ch-enroll' });
    expect(sent[1].body).toEqual({ challengeId: 'ch-enroll' });
  });

  it('verifyMfaEnrollment returns the recovery codes and starts a session when tokens come back', async () => {
    const withTokens = { enabled: true, recoveryCodes: ['A', 'B'], ...TOKENS, emailVerified: true };
    const { http, sent } = fakeHttp({ '/rest/v1/auth/mfa/verify-enrollment': withTokens, '/rest/v1/auth/me': {} });
    const auth = new AuthClient(http, false);
    const res = await auth.verifyMfaEnrollment('123456', { challengeId: 'ch-enroll' });
    expect(sent[0].body).toEqual({ code: '123456', challengeId: 'ch-enroll' });
    expect(res.data?.recoveryCodes).toEqual(['A', 'B']);
    expect(auth.getAccessToken()).toBe(TOKENS.accessToken);
  });

  it('verifyMfaEnrollment for a signed-in user leaves the session alone', async () => {
    const { http } = fakeHttp({ '/rest/v1/auth/mfa/verify-enrollment': { enabled: true, recoveryCodes: ['A'] } });
    const auth = new AuthClient(http, false);
    auth.setAccessToken('existing');
    await auth.verifyMfaEnrollment('123456');
    expect(auth.getAccessToken()).toBe('existing');
  });

  it('disableMfa, regenerateRecoveryCodes and getMfaStatus hit their routes', async () => {
    const { http, sent } = fakeHttp({
      '/rest/v1/auth/mfa/disable': { enabled: false },
      '/rest/v1/auth/mfa/recovery-codes': { recoveryCodes: ['N'] },
      '/rest/v1/auth/mfa': { enrolled: true, enrollmentRequired: false, recoveryCodesLeft: 8, verifiedAt: null },
    });
    const auth = new AuthClient(http, false);
    expect((await auth.disableMfa('111111')).data).toEqual({ enabled: false });
    expect(sent[0].body).toEqual({ code: '111111' });
    await auth.disableMfa('ABCDE-FGHJK', { recovery: true });
    expect(sent[1].body).toEqual({ recoveryCode: 'ABCDE-FGHJK' });
    expect((await auth.regenerateRecoveryCodes('222222')).data).toEqual({ recoveryCodes: ['N'] });
    expect((await auth.getMfaStatus()).data?.enrolled).toBe(true);
    expect(sent[3]).toMatchObject({ path: '/rest/v1/auth/mfa', method: undefined });
  });
});

describe('AuthClient — anonymous sessions', () => {
  it('signInAnonymously starts a session and isAnonymous reads the claim from the token', async () => {
    const anonTokens = { ...TOKENS, accessToken: jwt({ sub: 'anon-1', is_anonymous: true }), userId: 'anon-1', isAnonymous: true };
    const { http, sent } = fakeHttp({ '/rest/v1/auth/signin/anonymous': anonTokens, '/rest/v1/auth/me': {} });
    const auth = new AuthClient(http, false);
    expect(auth.isAnonymous()).toBe(false);
    const res = await auth.signInAnonymously();
    expect(sent[0]).toMatchObject({ path: '/rest/v1/auth/signin/anonymous', method: 'POST' });
    expect(res.data?.isAnonymous).toBe(true);
    expect(auth.isAnonymous()).toBe(true);
  });

  it('upgradeAnonymous posts the credentials and replaces the session with a normal one', async () => {
    const upgraded = { ...TOKENS, accessToken: jwt({ sub: 'anon-1' }), userId: 'anon-1', isAnonymous: false };
    const { http, sent } = fakeHttp({
      '/rest/v1/auth/signin/anonymous': { ...TOKENS, accessToken: jwt({ sub: 'anon-1', is_anonymous: true }) },
      '/rest/v1/auth/anonymous/upgrade': upgraded,
      '/rest/v1/auth/me': {},
    });
    const auth = new AuthClient(http, false);
    await auth.signInAnonymously();
    const res = await auth.upgradeAnonymous({ email: 'a@b.c', password: 'secret12', firstName: 'Ada' });
    expect(sent.find((s) => s.path === '/rest/v1/auth/anonymous/upgrade')).toMatchObject({
      method: 'POST',
      body: { email: 'a@b.c', password: 'secret12', firstName: 'Ada' },
    });
    expect(res.data).toEqual(upgraded);
    expect(auth.isAnonymous()).toBe(false);
    expect(auth.getAccessToken()).toBe(upgraded.accessToken);
  });

  it('a refused anonymous sign-in comes back as an error, not a throw', async () => {
    const { http } = fakeHttp({
      '/rest/v1/auth/signin/anonymous': { throws: { message: 'Anonymous sign-in is disabled for this project', status: 403 } },
    });
    const res = await new AuthClient(http, false).signInAnonymously();
    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(403);
  });
});
