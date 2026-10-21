jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('./keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));

import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { CONFIGURE_TOTP, PlatformMfaService } from './platform-mfa.service';

const config = {
  get: (k: string) =>
    ({
      'keycloak.url': 'http://kc',
      'keycloak.publicUrl': 'https://auth.example',
      'keycloak.adminClientId': 'admin-cli',
      'keycloak.adminUser': 'admin',
      publicApiUrl: 'https://api.example',
    } as Record<string, string>)[k],
};

function build(overrides: { hasOtp?: boolean; pending?: boolean; validates?: boolean; username?: string } = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    teamMember: { count: jest.fn(async () => 0) },
  };
  const keycloak = {
    userHasOtpCredential: jest.fn(async () => overrides.hasOtp ?? false),
    userHasRequiredAction: jest.fn(async () => overrides.pending ?? false),
    setUserRequiredAction: jest.fn(async () => undefined),
    removeUserRequiredAction: jest.fn(async () => undefined),
    directGrantValidatesOtp: jest.fn(async () => overrides.validates ?? true),
    getUserOtpCredentials: jest.fn(async () => (overrides.hasOtp ? [{ id: 'c1', type: 'otp', userLabel: 'Phone', createdDate: 1 }] : [])),
    removeUserCredential: jest.fn(async () => ({ message: 'ok' })),
    findPlatformUserByEmail: jest.fn(async () => ({ id: 'u1' })),
    getPlatformUsername: jest.fn(async () => overrides.username ?? 'user@example.com'),
    getPlatformUserSignInMethodsById: jest.fn(async (): Promise<any> => ({ signOnMethod: 'local', authProvider: 'local', linkedProviders: [], hasPasswordAuth: true })),
    getPlatformOAuthClientId: () => 'basefyio-platform',
  };
  const http = { post: jest.fn(() => of({ data: { access_token: 'x' } })) };
  const email = { sendRawHtml: jest.fn((..._args: any[]) => Promise.resolve()) };
  const svc = new PlatformMfaService(config as any, http as any, keycloak as any, prisma as any, email as any);
  return { svc, prisma, keycloak, http, email };
}

const plainUser = { id: 'u1', mfaEnrolledAt: null, teamMembers: [] as Array<{ team: { name: string } }> };
const requiredUser = { id: 'u1', mfaEnrolledAt: null, teamMembers: [{ team: { name: 'Acme' } }] };

describe('PlatformMfaService.resolveLoginMfa', () => {
  it('makes no Keycloak call for an account that is neither enrolled nor under a policy', async () => {
    const { svc, keycloak } = build();
    const state = await svc.resolveLoginMfa(plainUser);
    expect(state).toEqual({ userId: 'u1', hasOtp: false, required: false, requiredBy: [] });
    expect(keycloak.userHasOtpCredential).not.toHaveBeenCalled();
  });

  it('returns a neutral state for an unknown email', async () => {
    const { svc } = build();
    expect(await svc.resolveLoginMfa(null)).toEqual({ hasOtp: false, required: false, requiredBy: [] });
  });

  it('asks Keycloak when the mirror says enrolled and heals the mirror on drift', async () => {
    const { svc, keycloak, prisma } = build({ hasOtp: false });
    const state = await svc.resolveLoginMfa({ ...plainUser, mfaEnrolledAt: new Date() });
    expect(keycloak.userHasOtpCredential).toHaveBeenCalledWith('master', 'u1');
    expect(state.hasOtp).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { mfaEnrolledAt: null } });
  });

  it('asks Keycloak when a team requires it', async () => {
    const { svc, keycloak } = build({ hasOtp: true });
    const state = await svc.resolveLoginMfa(requiredUser);
    expect(keycloak.userHasOtpCredential).toHaveBeenCalled();
    expect(state).toMatchObject({ hasOtp: true, required: true, requiredBy: ['Acme'] });
  });

  it('does not set the mirror on its own: a new factor is recorded after a successful sign-in', async () => {
    const { svc, prisma } = build({ hasOtp: true });
    const state = await svc.resolveLoginMfa(requiredUser);
    expect(state.hasOtp).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('falls back to the mirror when Keycloak is unreachable', async () => {
    const { svc, keycloak } = build();
    keycloak.userHasOtpCredential.mockRejectedValue(new Error('down'));
    const state = await svc.resolveLoginMfa({ ...plainUser, mfaEnrolledAt: new Date() });
    expect(state.hasOtp).toBe(true);
  });
});

describe('PlatformMfaService.handleGrantError', () => {
  const notSetUp = { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Account is not fully set up' } } };
  const badPassword = { response: { status: 401, data: { error: 'invalid_grant', error_description: 'Invalid user credentials' } } };

  it('leaves an ordinary failure to the caller', async () => {
    const { svc } = build();
    expect(await svc.handleGrantError(badPassword, 'a@b.c', { userId: 'u1', hasOtp: false, required: true, requiredBy: ['Acme'] })).toBeNull();
  });

  it('sends a required member with pending setup to enrol', async () => {
    const { svc } = build({ pending: true });
    const out = await svc.handleGrantError(notSetUp, 'a@b.c', { userId: 'u1', hasOtp: false, required: true, requiredBy: ['Acme'] });
    expect(out?.kind).toBe('enrollment_required');
    expect((out as any).enrollUrl).toContain('kc_action=CONFIGURE_TOTP');
  });

  it('releases the pending setup and asks for a retry when no team requires it any more', async () => {
    const { svc, keycloak } = build({ pending: true });
    const out = await svc.handleGrantError(notSetUp, 'a@b.c', { userId: 'u1', hasOtp: false, required: false, requiredBy: [] });
    expect(out).toEqual({ kind: 'retry' });
    expect(keycloak.removeUserRequiredAction).toHaveBeenCalledWith('master', 'u1', CONFIGURE_TOTP);
  });

  it('does not touch a different pending action', async () => {
    const { svc, keycloak } = build({ pending: false });
    expect(await svc.handleGrantError(notSetUp, 'a@b.c', { userId: 'u1', hasOtp: false, required: false, requiredBy: [] })).toBeNull();
    expect(keycloak.removeUserRequiredAction).not.toHaveBeenCalled();
  });
});

describe('PlatformMfaService.afterLoginSuccess', () => {
  it('marks a required member without an authenticator for setup and withholds tokens', async () => {
    const { svc, keycloak } = build();
    const out = await svc.afterLoginSuccess('a@b.c', { userId: 'u1', hasOtp: false, required: true, requiredBy: ['Acme'] }, { id: 'u1', email: 'a@b.c', mfaEnrolledAt: null });
    expect(keycloak.setUserRequiredAction).toHaveBeenCalledWith('master', 'u1', CONFIGURE_TOTP, true);
    expect(out?.kind).toBe('enrollment_required');
  });

  it('asks nothing of Keycloak for an account with no factor and no policy', async () => {
    const { svc, keycloak, prisma } = build();
    const out = await svc.afterLoginSuccess('a@b.c', { userId: 'u1', hasOtp: false, required: false, requiredBy: [] }, { id: 'u1', email: 'a@b.c', mfaEnrolledAt: null });
    expect(out).toBeNull();
    expect(keycloak.getPlatformUsername).not.toHaveBeenCalled();
    expect(keycloak.setUserRequiredAction).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('still withholds tokens when the setup marker cannot be written', async () => {
    const { svc, keycloak } = build();
    keycloak.setUserRequiredAction.mockRejectedValue(new Error('kc down'));
    const out = await svc.afterLoginSuccess('a@b.c', { userId: 'u1', hasOtp: false, required: true, requiredBy: ['Acme'] }, null);
    expect(out?.kind).toBe('enrollment_required');
  });

  it('never marks the Keycloak admin account', async () => {
    const { svc, keycloak } = build({ username: 'admin' });
    const out = await svc.afterLoginSuccess('admin@example.com', { userId: 'u1', hasOtp: false, required: true, requiredBy: ['Acme'] }, null);
    expect(out).toBeNull();
    expect(keycloak.setUserRequiredAction).not.toHaveBeenCalled();
  });

  it('sets the mirror and emails once when a fresh authenticator is seen', async () => {
    const { svc, prisma, email } = build({ hasOtp: true });
    const out = await svc.afterLoginSuccess('a@b.c', { userId: 'u1', hasOtp: true, required: false, requiredBy: [] }, { id: 'u1', email: 'a@b.c', mfaEnrolledAt: null });
    expect(out).toBeNull();
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(email.sendRawHtml).toHaveBeenCalledTimes(1);
    expect(email.sendRawHtml.mock.calls[0][1]).toMatch(/turned on/);
  });

  it('does nothing for an enrolled user whose mirror is already set', async () => {
    const { svc, prisma, email } = build({ hasOtp: true });
    await svc.afterLoginSuccess('a@b.c', { userId: 'u1', hasOtp: true, required: false, requiredBy: [] }, { id: 'u1', email: 'a@b.c', mfaEnrolledAt: new Date() });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(email.sendRawHtml).not.toHaveBeenCalled();
  });
});

describe('PlatformMfaService self-service', () => {
  it('builds an enrolment URL that returns to the dashboard through /login', () => {
    const { svc } = build();
    const url = new URL(svc.buildEnrollUrl('a@b.c'));
    expect(url.origin + url.pathname).toBe('https://auth.example/realms/master/protocol/openid-connect/auth');
    expect(url.searchParams.get('client_id')).toBe('basefyio-platform');
    expect(url.searchParams.get('kc_action')).toBe('CONFIGURE_TOTP');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('login_hint')).toBe('a@b.c');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example/api/auth/oauth/callback');
    const state = JSON.parse(Buffer.from(url.searchParams.get('state')!, 'base64url').toString());
    expect(state.redirectTo).toBe('/login?next=%2Fdashboard%2Faccount%3Fmfa%3Denrolled');
    expect(state.mfaEnroll).toBe(true);
  });

  it('refuses an unsafe next path', () => {
    const { svc } = build();
    const url = new URL(svc.buildEnrollUrl('a@b.c', '//evil.example'));
    const state = JSON.parse(Buffer.from(url.searchParams.get('state')!, 'base64url').toString());
    expect(state.redirectTo).toBe('/login?next=%2Fdashboard%2Faccount%3Fmfa%3Denrolled');
  });

  it('refuses enrolment when the direct-grant flow does not validate codes', async () => {
    const { svc, prisma } = build({ validates: false });
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.c' });
    await expect(svc.enrollUrlFor('u1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('status reports availability, factors and the teams that require it', async () => {
    const { svc, prisma } = build({ hasOtp: true });
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      mfaEnrolledAt: new Date('2026-10-01T00:00:00.000Z'),
      teamMembers: [{ team: { id: 't1', name: 'Acme' } }],
    });
    const s = await svc.status('u1');
    expect(s).toMatchObject({
      available: true,
      enabled: true,
      requiredByTeams: [{ id: 't1', name: 'Acme' }],
      selfServiceDisable: true,
    });
    expect(s.factors).toHaveLength(1);
    // Already enrolled: nothing to set up.
    expect(s.enrollUrl).toBeNull();
  });

  it('status offers enrolment when off and records a factor the mirror missed, with one email', async () => {
    const { svc, prisma, keycloak, email } = build({ hasOtp: false });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', mfaEnrolledAt: null, teamMembers: [] });
    const off = await svc.status('u1');
    expect(off.enabled).toBe(false);
    expect(off.enrollUrl).toContain('kc_action=CONFIGURE_TOTP');
    expect(prisma.user.update).not.toHaveBeenCalled();

    keycloak.getUserOtpCredentials.mockResolvedValue([{ id: 'c9', type: 'otp', userLabel: 'Phone', createdDate: 2 }]);
    const on = await svc.status('u1');
    expect(on.enabled).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { mfaEnrolledAt: expect.any(Date) } });
    expect(email.sendRawHtml).toHaveBeenCalledTimes(1);
  });

  it('status keeps the mirror when Keycloak cannot list authenticators', async () => {
    const { svc, prisma, keycloak } = build();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', mfaEnrolledAt: new Date(), teamMembers: [] });
    keycloak.getUserOtpCredentials.mockRejectedValue(new Error('down'));
    const s = await svc.status('u1');
    expect(s.enabled).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('status tells a social-only account that turning it off needs a root reset', async () => {
    const { svc, prisma, keycloak } = build({ hasOtp: true });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', mfaEnrolledAt: new Date(), teamMembers: [] });
    keycloak.getPlatformUserSignInMethodsById.mockResolvedValue({ signOnMethod: 'github', authProvider: 'github', linkedProviders: ['github'], hasPasswordAuth: false });
    expect((await svc.status('u1')).selfServiceDisable).toBe(false);
  });

  it('disable refuses while a team requires two-factor authentication', async () => {
    const { svc, prisma } = build({ hasOtp: true });
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.c', teamMembers: [{ team: { name: 'Acme' } }] });
    await expect(svc.disable('u1', 'pw', '123456')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('disable refuses social-only accounts (root reset instead)', async () => {
    const { svc, prisma, keycloak } = build({ hasOtp: true });
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.c', teamMembers: [] });
    keycloak.getPlatformUserSignInMethodsById.mockResolvedValue({ signOnMethod: 'google', authProvider: 'google', linkedProviders: ['google'], hasPasswordAuth: false });
    await expect(svc.disable('u1', 'pw', '123456')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('disable refuses an account linked to a provider even if it still holds a password', async () => {
    const { svc, prisma, keycloak, http } = build({ hasOtp: true });
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.c', teamMembers: [] });
    keycloak.getPlatformUserSignInMethodsById.mockResolvedValue({ signOnMethod: 'google', authProvider: 'google', linkedProviders: ['google'], hasPasswordAuth: true });
    await expect(svc.disable('u1', 'pw', '123456')).rejects.toMatchObject({ response: { code: 'MFA_SOCIAL_ACCOUNT' } });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('disable re-authenticates with password and code, then removes only otp credentials', async () => {
    const { svc, prisma, keycloak, http, email } = build({ hasOtp: true });
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.c', teamMembers: [] });
    const result = await svc.disable('u1', 'pw', '123456');
    const body = String((http.post.mock.calls[0] as unknown as [string, string])[1]);
    expect(body).toContain('totp=123456');
    expect(body).toContain('password=pw');
    expect(keycloak.removeUserCredential).toHaveBeenCalledWith('master', 'u1', 'c1');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { mfaEnrolledAt: null } });
    expect(email.sendRawHtml).toHaveBeenCalledTimes(1);
    expect(result.removed).toBe(1);
  });

  it('disable rejects a wrong password or code', async () => {
    const { svc, prisma, http, keycloak } = build({ hasOtp: true });
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.c', teamMembers: [] });
    http.post.mockImplementation(() => {
      throw new Error('401');
    });
    await expect(svc.disable('u1', 'pw', '000000')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(keycloak.removeUserCredential).not.toHaveBeenCalled();
  });

  it('root reset removes credentials and the pending setup action', async () => {
    const { svc, keycloak, prisma } = build({ hasOtp: true });
    const r = await svc.resetForUser('u1');
    expect(keycloak.removeUserCredential).toHaveBeenCalledWith('master', 'u1', 'c1');
    expect(keycloak.removeUserRequiredAction).toHaveBeenCalledWith('master', 'u1', CONFIGURE_TOTP);
    expect(prisma.user.update).toHaveBeenCalled();
    expect(r.removed).toBe(1);
  });
});

describe('PlatformMfaService.checkBrowserSignIn', () => {
  it('lets an ordinary browser sign-in through with only the user lookup', async () => {
    const { svc, prisma, keycloak } = build();
    prisma.user.findUnique.mockResolvedValue({ ...plainUser, email: 'a@b.c' });
    expect(await svc.checkBrowserSignIn('u1', false)).toBeNull();
    expect(keycloak.userHasOtpCredential).not.toHaveBeenCalled();
    expect(keycloak.setUserRequiredAction).not.toHaveBeenCalled();
  });

  it('sends a required member without an authenticator to set one up', async () => {
    const { svc, prisma, keycloak } = build({ hasOtp: false });
    prisma.user.findUnique.mockResolvedValue({ ...requiredUser, email: 'a@b.c' });
    const gate = await svc.checkBrowserSignIn('u1', false);
    expect(gate?.enrollUrl).toContain('kc_action=CONFIGURE_TOTP');
    expect(keycloak.setUserRequiredAction).toHaveBeenCalledWith('master', 'u1', CONFIGURE_TOTP, true);
  });

  it('records the factor when the callback ends an enrolment', async () => {
    const { svc, prisma, email } = build({ hasOtp: true });
    prisma.user.findUnique.mockResolvedValue({ ...requiredUser, email: 'a@b.c' });
    expect(await svc.checkBrowserSignIn('u1', true)).toBeNull();
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { mfaEnrolledAt: expect.any(Date) } });
    expect(email.sendRawHtml).toHaveBeenCalledTimes(1);
  });

  it('sends a required member back to the setup page when an enrolment was abandoned', async () => {
    const { svc, prisma } = build({ hasOtp: false });
    prisma.user.findUnique.mockResolvedValue({ ...requiredUser, email: 'a@b.c' });
    const gate = await svc.checkBrowserSignIn('u1', true);
    expect(gate?.enrollUrl).toContain('kc_action=CONFIGURE_TOTP');
  });
});
