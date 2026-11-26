import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ProjectSdkAuthService } from './project-sdk-auth.service';
import { ProjectSdkAuthController } from './project-sdk-auth.controller';
import { ProjectOAuthCallbackController } from './project-oauth-callback.controller';

/**
 * Social sign-in round trip (customer report, realm kb-payfyio_cloud): prompt pass-through,
 * the app's own state, errors back to the app instead of a page, addresses Google/GitHub
 * vouch for, a sign-out URL without a confirmation page, resending the verification mail.
 */

const APP = 'https://app.example.com/auth/callback';
const REALM = 'kb-p1';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const state = (o: Record<string, unknown>) => b64(o);

function build(opts: { claims?: Record<string, unknown>; tokenFails?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    del: jest.fn(async (k: string) => void store.delete(k)),
    incr: jest.fn(async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    }),
    expire: jest.fn(async () => undefined),
  };
  const claims = opts.claims ?? { sub: 'u1', email: 'ada@example.com', email_verified: true };
  const http = {
    post: jest.fn((url: string, body: string) => {
      if (opts.tokenFails) return throwError(() => new Error('invalid_grant'));
      const grant = new URLSearchParams(body).get('grant_type');
      const access = grant === 'refresh_token' ? jwt({ ...claims, email_verified: true }) : jwt(claims);
      return of({
        data: {
          access_token: access,
          refresh_token: grant === 'refresh_token' ? 'rt-2' : 'rt-1',
          expires_in: 300,
          token_type: 'Bearer',
          id_token: grant === 'refresh_token' ? 'idt-2' : 'idt-1',
        },
      });
    }),
    get: jest.fn(),
  };
  const keycloak = {
    ensureAnonClientRedirectUri: jest.fn(async () => undefined),
    ensureAnonClientPostLogoutRedirectUri: jest.fn(async () => undefined),
    identityProviderTrustsEmail: jest.fn(async () => true),
    listUserFederatedIdentityLinks: jest.fn(async () => [{ identityProvider: 'github', userName: 'ada' }]),
    listUserFederatedIdentities: jest.fn(async () => ['github']),
    setEmailVerified: jest.fn(async () => undefined),
    findUserInRealm: jest.fn(async () => null as any),
    isAnonymousUser: jest.fn(() => false),
  };
  const cfg: Record<string, string> = {
    'keycloak.url': 'http://keycloak:8080',
    'keycloak.publicUrl': 'https://auth.example.com',
    publicApiUrl: 'https://api.example.com',
  };
  const svc: any = Object.create(ProjectSdkAuthService.prototype);
  Object.assign(svc, {
    redis,
    http,
    keycloak,
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() },
    config: { get: (k: string) => cfg[k] },
    authConfig: { getRaw: jest.fn(async () => ({ redirectUrls: ['https://app.example.com/auth'] })) },
  });
  svc.getProject = jest.fn(async () => ({ id: 'p1', name: 'P', keycloakRealm: REALM, anonKey: 'anon' }));
  svc.sendEmail = jest.fn(async () => undefined);
  svc.revokeRefreshToken = jest.fn(async () => undefined);
  return { svc, http, keycloak, store };
}

const query = (url: string) => new URL(url).searchParams;

describe('signin/:provider', () => {
  it('passes the caller\'s prompt and keeps its state inside ours', async () => {
    const { svc } = build();
    const { url } = await svc.getOAuthRedirectUrl('p1', 'github', `${APP}?next=%2Fbilling`, {
      prompt: 'select_account',
      appState: 'csrf-123',
    });
    const q = query(url);
    expect(url.startsWith(`https://auth.example.com/realms/${REALM}/protocol/openid-connect/auth?`)).toBe(true);
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('kc_idp_hint')).toBe('github');
    const inner = JSON.parse(Buffer.from(q.get('state')!, 'base64url').toString());
    expect(inner).toEqual({ redirectTo: `${APP}?next=%2Fbilling`, appState: 'csrf-123' });
  });

  it('defaults to the prompt the provider config used to force', async () => {
    const { svc } = build();
    expect(query((await svc.getOAuthRedirectUrl('p1', 'google', APP)).url).get('prompt')).toBe('select_account login');
    expect(query((await svc.getOAuthRedirectUrl('p1', 'github', APP)).url).get('prompt')).toBe('login');
    expect(query((await svc.getOAuthRedirectUrl('p1', 'gitlab', APP)).url).get('prompt')).toBeNull();
  });

  it('still refuses an unregistered redirect_to', async () => {
    const { svc } = build();
    await expect(svc.getOAuthRedirectUrl('p1', 'github', 'https://evil.example.net/')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the controller refuses a prompt or state outside the allowlist before anything runs', async () => {
    const getOAuthRedirectUrl = jest.fn();
    const controller = new ProjectSdkAuthController({ getOAuthRedirectUrl } as any, {} as any, {} as any);
    const req: any = { apiKeyPayload: { projectId: 'p1' } };
    await expect(controller.signinWithProvider(req, 'github', APP, 'login&x=1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.signinWithProvider(req, 'github', APP, 'login', 'a b')).rejects.toBeInstanceOf(BadRequestException);
    expect(getOAuthRedirectUrl).not.toHaveBeenCalled();
    await controller.signinWithProvider(req, 'github', APP, 'none', 'ok');
    expect(getOAuthRedirectUrl).toHaveBeenCalledWith('p1', 'github', APP, { prompt: 'none', appState: 'ok' });
  });
});

describe('OAuth callback', () => {
  it('returns the tokens, the id token and the app state', async () => {
    const { svc, keycloak } = build();
    const r = await svc.handleOAuthCallback('p1', 'github', 'code', state({ redirectTo: `${APP}?x=1`, appState: 's1' }));
    expect(r).toMatchObject({ ok: true, refreshToken: 'rt-1', idToken: 'idt-1', redirectTo: `${APP}?x=1`, appState: 's1' });
    expect(keycloak.setEmailVerified).not.toHaveBeenCalled();
  });

  it('drops a state value of the wrong shape and re-checks the redirect', async () => {
    const { svc } = build();
    const r = await svc.handleOAuthCallback('p1', 'github', 'code', state({ redirectTo: 'https://evil.example.net/', appState: '<x>' }));
    expect(r).toMatchObject({ ok: true, redirectTo: '/' });
    expect((r as any).appState).toBeUndefined();
  });

  it('marks a GitHub address verified when the provider trusts it, and hands out the refreshed token', async () => {
    const { svc, keycloak } = build({ claims: { sub: 'u1', email: 'ada@example.com', email_verified: false } });
    const r: any = await svc.handleOAuthCallback('p1', 'github', 'code', state({ redirectTo: APP }));
    expect(keycloak.setEmailVerified).toHaveBeenCalledWith(REALM, 'u1');
    expect(r.refreshToken).toBe('rt-2');
    expect(r.idToken).toBe('idt-2');
    expect(JSON.parse(Buffer.from(r.accessToken.split('.')[1], 'base64url').toString()).email_verified).toBe(true);
  });

  it('does not mark it when the provider does not trust email, or the user is not linked to it', async () => {
    const claims = { sub: 'u1', email: 'ada@example.com', email_verified: false };
    const a = build({ claims });
    a.keycloak.identityProviderTrustsEmail.mockResolvedValue(false);
    await a.svc.handleOAuthCallback('p1', 'github', 'code', state({ redirectTo: APP }));
    expect(a.keycloak.setEmailVerified).not.toHaveBeenCalled();

    const b = build({ claims });
    b.keycloak.listUserFederatedIdentityLinks.mockResolvedValue([]);
    await b.svc.handleOAuthCallback('p1', 'github', 'code', state({ redirectTo: APP }));
    expect(b.keycloak.setEmailVerified).not.toHaveBeenCalled();
  });

  it('for Google, only when the address is still the one Google gave', async () => {
    const claims = { sub: 'u1', email: 'ada@example.com', email_verified: false };
    const a = build({ claims });
    a.keycloak.listUserFederatedIdentityLinks.mockResolvedValue([{ identityProvider: 'google', userName: 'other@example.com' }]);
    await a.svc.handleOAuthCallback('p1', 'google', 'code', state({ redirectTo: APP }));
    expect(a.keycloak.setEmailVerified).not.toHaveBeenCalled();

    const b = build({ claims });
    b.keycloak.listUserFederatedIdentityLinks.mockResolvedValue([{ identityProvider: 'google', userName: 'Ada@Example.com' }]);
    await b.svc.handleOAuthCallback('p1', 'google', 'code', state({ redirectTo: APP }));
    expect(b.keycloak.setEmailVerified).toHaveBeenCalledWith(REALM, 'u1');
  });

  it('answers missing_profile and ends the session when GitHub gave no address', async () => {
    const { svc } = build({ claims: { sub: 'u1' } });
    const r = await svc.handleOAuthCallback('p1', 'github', 'code', state({ redirectTo: APP, appState: 's1' }));
    expect(r).toEqual({ ok: false, error: 'missing_profile', redirectTo: APP, appState: 's1' });
    expect(svc.revokeRefreshToken).toHaveBeenCalledWith(REALM, `${REALM}-anon`, 'rt-1');
  });

  it('answers oauth_failed instead of a 500 when the code exchange fails', async () => {
    const { svc } = build({ tokenFails: true });
    await expect(svc.handleOAuthCallback('p1', 'github', 'code', state({ redirectTo: APP }))).resolves.toMatchObject({
      ok: false,
      error: 'oauth_failed',
      redirectTo: APP,
    });
  });

  it('maps a Keycloak error to our code', async () => {
    const { svc } = build();
    await expect(svc.handleOAuthError('p1', state({ redirectTo: APP }), 'login_required')).resolves.toMatchObject({
      ok: false,
      error: 'login_required',
    });
    await expect(svc.handleOAuthError('p1', 'not-base64-json', 'x')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('callback controller', () => {
  function run(result: any) {
    const sdkAuth = {
      handleOAuthCallback: jest.fn(async () => result),
      handleOAuthError: jest.fn(async () => result),
    };
    const controller = new ProjectOAuthCallbackController(sdkAuth as any, {} as any);
    const res: any = { redirect: jest.fn() };
    return { controller, res, sdkAuth };
  }

  it('puts the id token and the app state in the fragment', async () => {
    const { controller, res } = run({
      ok: true, accessToken: 'a', refreshToken: 'r', expiresIn: 300, tokenType: 'Bearer', idToken: 'i', redirectTo: `${APP}?x=1`, appState: 's1',
    });
    await controller.oauthCallback(res, 'p1', 'github', 'code', 'st');
    expect(res.redirect).toHaveBeenCalledWith(
      `${APP}?x=1#access_token=a&refresh_token=r&expires_in=300&token_type=Bearer&provider=github&id_token=i&state=s1`,
    );
  });

  it('sends an error back to the app, never to a page', async () => {
    const { controller, res, sdkAuth } = run({ ok: false, error: 'access_denied', redirectTo: APP, appState: 's1' });
    await controller.oauthCallback(res, 'p1', 'github', undefined as any, 'st', 'access_denied');
    expect(sdkAuth.handleOAuthError).toHaveBeenCalledWith('p1', 'st', 'access_denied');
    const location = res.redirect.mock.calls[0][0] as string;
    const fragment = new URLSearchParams(location.split('#')[1]);
    expect(location.startsWith(`${APP}#`)).toBe(true);
    expect(fragment.get('error')).toBe('access_denied');
    expect(fragment.get('state')).toBe('s1');
    expect(fragment.get('access_token')).toBeNull();
  });
});

describe('sign-out URL', () => {
  const idToken = jwt({ iss: `https://auth.example.com/realms/${REALM}`, azp: `${REALM}-anon`, aud: `${REALM}-anon` });

  it('builds Keycloak\'s logout URL with id_token_hint and our own callback', async () => {
    const { svc, keycloak } = build();
    const { url, confirmationSkipped } = await svc.getLogoutUrl('p1', { redirectTo: APP, idToken, appState: 's1' });
    const q = query(url);
    expect(url.startsWith(`https://auth.example.com/realms/${REALM}/protocol/openid-connect/logout?`)).toBe(true);
    expect(q.get('id_token_hint')).toBe(idToken);
    expect(q.get('client_id')).toBe(`${REALM}-anon`);
    expect(q.get('post_logout_redirect_uri')).toBe('https://api.example.com/api/rest/v1/auth/logout-callback/p1');
    expect(confirmationSkipped).toBe(true);
    expect(keycloak.ensureAnonClientPostLogoutRedirectUri).toHaveBeenCalledWith(
      REALM,
      'https://api.example.com/api/rest/v1/auth/logout-callback/p1',
    );
    // And back: allowlist checked again, state returned.
    expect(await svc.handleLogoutCallback('p1', q.get('state')!)).toBe(`${APP}#signed_out=true&state=s1`);
  });

  it('refuses an unregistered or missing redirect and a token from another realm', async () => {
    const { svc } = build();
    await expect(svc.getLogoutUrl('p1', { redirectTo: 'https://evil.example.net/' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.getLogoutUrl('p1', {})).rejects.toBeInstanceOf(BadRequestException);
    const foreign = jwt({ iss: 'https://auth.example.com/realms/other', azp: 'other-anon' });
    await expect(svc.getLogoutUrl('p1', { redirectTo: APP, idToken: foreign })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.getLogoutUrl('p1', { redirectTo: APP, idToken: 'garbage' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a tampered state on the way back cannot leave the allowlist', async () => {
    const { svc } = build();
    expect(await svc.handleLogoutCallback('p1', state({ redirectTo: 'https://evil.example.net/' }))).toBe('/#signed_out=true');
    expect(await svc.handleLogoutCallback('p1', '%%%')).toBe('/#signed_out=true');
  });
});

describe('verify-email/resend', () => {
  const ANSWER = { message: 'If the address is waiting for verification, a new code has been sent' };

  it('mails a new code to an unconfirmed account', async () => {
    const { svc, keycloak } = build();
    keycloak.findUserInRealm.mockResolvedValue({ id: 'u1', email: 'ada@example.com', emailVerified: false });
    await expect(svc.resendEmailVerification('p1', 'ada@example.com', '1.2.3.4')).resolves.toEqual(ANSWER);
    expect(svc.sendEmail).toHaveBeenCalledWith('p1', 'ada@example.com', 'P', 'verify', expect.objectContaining({ otp: expect.any(String) }));
  });

  it('answers the same for an unknown or already confirmed address, without mailing', async () => {
    const { svc, keycloak } = build();
    await expect(svc.resendEmailVerification('p1', 'nobody@example.com')).resolves.toEqual(ANSWER);
    keycloak.findUserInRealm.mockResolvedValue({ id: 'u1', email: 'ada@example.com', emailVerified: true });
    await expect(svc.resendEmailVerification('p1', 'ada@example.com')).resolves.toEqual(ANSWER);
    expect(svc.sendEmail).not.toHaveBeenCalled();
  });

  it('limits per address whether or not it exists', async () => {
    const { svc } = build();
    for (let i = 0; i < 3; i++) await svc.resendEmailVerification('p1', 'nobody@example.com');
    const fourth = svc.resendEmailVerification('p1', 'Nobody@example.com');
    await expect(fourth).rejects.toBeInstanceOf(HttpException);
    await expect(fourth).rejects.toMatchObject({ status: 429 });
  });

  it('limits per client IP across addresses', async () => {
    const { svc } = build();
    for (let i = 0; i < 20; i++) await svc.resendEmailVerification('p1', `u${i}@example.com`, '9.9.9.9');
    await expect(svc.resendEmailVerification('p1', 'u99@example.com', '9.9.9.9')).rejects.toMatchObject({ status: 429 });
  });

  it('refuses a missing address', async () => {
    const { svc } = build();
    await expect(svc.resendEmailVerification('p1', '')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.resendEmailVerification('p1', 5)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('signup while verification is pending', () => {
  function signupSvc(grant: () => Promise<any>, requireEmailVerify = true) {
    const { svc, keycloak } = build();
    Object.assign(keycloak, { createProjectUser: jest.fn(async () => 'u1') });
    svc.authConfig = { getOrCreate: jest.fn(async () => ({ allowSignup: true, minPasswordLength: 6, requireEmailVerify })) } as any;
    svc.issueEmailVerification = jest.fn(async () => undefined);
    svc.authenticateInRealm = jest.fn(grant);
    return svc;
  }

  it('answers without tokens when the realm holds sign-in until the address is confirmed', async () => {
    const svc = signupSvc(async () => {
      throw new UnauthorizedException('Account is not fully set up');
    });
    await expect(svc.signup('p1', { email: 'ada@example.com', password: 'secret12' })).resolves.toEqual({
      userId: 'u1',
      emailVerified: false,
      verificationRequired: true,
    });
    expect(svc.issueEmailVerification).toHaveBeenCalled();
  });

  it('returns tokens with emailVerified false when the realm lets the user in', async () => {
    const svc = signupSvc(async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 300, tokenType: 'Bearer' }));
    await expect(svc.signup('p1', { email: 'ada@example.com', password: 'secret12' })).resolves.toMatchObject({
      accessToken: 'a',
      emailVerified: false,
      verificationRequired: true,
    });
  });

  it('still fails a grant error when verification is not required', async () => {
    const svc = signupSvc(async () => {
      throw new UnauthorizedException('x');
    }, false);
    (svc.keycloak as any).setEmailVerified = jest.fn(async () => undefined);
    await expect(svc.signup('p1', { email: 'ada@example.com', password: 'secret12' })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('/auth/me provider', () => {
  function meSvc(providers: string[], isAnonymous = false) {
    const { svc, keycloak } = build();
    keycloak.listUserFederatedIdentities.mockResolvedValue(providers);
    svc.getUserFromToken = jest.fn(async () => ({ id: 'u1', email: 'a@b.co', emailVerified: true, isAnonymous })) as any;
    return svc;
  }

  it('names the linked provider, or password', async () => {
    await expect(meSvc(['github']).me('p1', 't')).resolves.toMatchObject({ provider: 'github', providers: ['github'] });
    await expect(meSvc([]).me('p1', 't')).resolves.toMatchObject({ provider: 'password', providers: [] });
    await expect(meSvc([], true).me('p1', 't')).resolves.toMatchObject({ provider: 'anonymous' });
  });

  it('still answers when the lookup fails', async () => {
    const svc = meSvc([]);
    (svc.keycloak as any).listUserFederatedIdentities.mockRejectedValue(new Error('down'));
    await expect(svc.me('p1', 't')).resolves.toMatchObject({ id: 'u1', provider: 'password' });
  });
});
