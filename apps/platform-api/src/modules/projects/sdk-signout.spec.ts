import { UnauthorizedException } from '@nestjs/common';
import { SupabaseAuthCompatService } from './supabase-auth-compat.service';

/** POST /rest/v1/auth/signout — what basefyio-js signOut() calls (#247). */
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;

function build() {
  const svc: any = Object.create(SupabaseAuthCompatService.prototype);
  svc.logger = { warn: jest.fn(), log: jest.fn() };
  svc.getProject = jest.fn(async () => ({ id: 'p1', keycloakRealm: 'proj-r' }));
  svc.sdkAuth = { revokeRefreshToken: jest.fn(async () => undefined) };
  svc.keycloak = {
    revokeUserSession: jest.fn(async () => undefined),
    listUserSessions: jest.fn(async () => [{ id: 's1' }, { id: 's2' }]),
    logoutAllUserSessions: jest.fn(async () => undefined),
  };
  return svc;
}

describe('SupabaseAuthCompatService.signOutSdk', () => {
  it('revokes the refresh token with the client that issued it, no access token needed', async () => {
    const svc = build();
    const rt = jwt({ azp: 'proj-r-anon-aal2', typ: 'Refresh' });
    await svc.signOutSdk('p1', undefined, 'local', rt);
    expect(svc.sdkAuth.revokeRefreshToken).toHaveBeenCalledWith('proj-r', 'proj-r-anon-aal2', rt);
    expect(svc.keycloak.logoutAllUserSessions).not.toHaveBeenCalled();
  });

  it('falls back to the realm public client for a token from elsewhere', async () => {
    const svc = build();
    const rt = jwt({ azp: 'some-other-client' });
    await svc.signOutSdk('p1', undefined, 'local', rt);
    expect(svc.sdkAuth.revokeRefreshToken).toHaveBeenCalledWith('proj-r', 'proj-r-anon', rt);
  });

  it('ends only the access token session for local without a refresh token', async () => {
    const svc = build();
    await svc.signOutSdk('p1', { sub: 'u1', sid: 's1' }, 'local');
    expect(svc.keycloak.revokeUserSession).toHaveBeenCalledWith('proj-r', 's1');
    expect(svc.keycloak.logoutAllUserSessions).not.toHaveBeenCalled();
  });

  it('never ends every session when a local sign-out has no session id', async () => {
    const svc = build();
    await svc.signOutSdk('p1', { sub: 'u1' }, 'local');
    expect(svc.keycloak.logoutAllUserSessions).not.toHaveBeenCalled();
    expect(svc.keycloak.revokeUserSession).not.toHaveBeenCalled();
  });

  it('global and others need the user and do what they say', async () => {
    const svc = build();
    await expect(svc.signOutSdk('p1', undefined, 'global')).rejects.toBeInstanceOf(UnauthorizedException);
    await svc.signOutSdk('p1', { sub: 'u1', sid: 's1' }, 'others');
    expect(svc.keycloak.revokeUserSession).toHaveBeenCalledWith('proj-r', 's2');
    expect(svc.keycloak.revokeUserSession).not.toHaveBeenCalledWith('proj-r', 's1');
    await svc.signOutSdk('p1', { sub: 'u1' }, 'global');
    expect(svc.keycloak.logoutAllUserSessions).toHaveBeenCalledWith('proj-r', 'u1');
  });

  it('refuses a local sign-out with neither token', async () => {
    const svc = build();
    await expect(svc.signOutSdk('p1', undefined, 'local')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
