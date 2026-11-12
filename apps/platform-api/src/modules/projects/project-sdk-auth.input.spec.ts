// The Keycloak admin client is ESM-only and Jest cannot load it; the Prisma
// client and the mailer are not needed here either. Only identities matter.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('../redis/redis.service', () => ({ RedisService: class {} }));
jest.mock('./project-auth-config.service', () => ({ ProjectAuthConfigService: class {} }));
jest.mock('./project-mfa.service', () => ({ ProjectMfaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { ProjectSdkAuthService } from './project-sdk-auth.service';

/**
 * Sign-up input is checked before anything is looked up, and sign-out revokes
 * the refresh token on the server (#169).
 */

const PROJECT = { id: 'p1', name: 'Shop', keycloakRealm: 'realm-p1', anonKey: 'bf_anon_x' };

function build() {
  const prisma = { project: { findFirst: jest.fn().mockResolvedValue(PROJECT) } };
  // An empty search used to match an existing account: the 409 this fixes.
  const keycloak = { findUserInRealm: jest.fn().mockResolvedValue({ id: 'someone' }) };
  const http = { post: jest.fn().mockReturnValue(of({ data: {} })) };
  const config = { get: jest.fn().mockReturnValue('http://keycloak.test') };
  const authConfig = { getOrCreate: jest.fn().mockResolvedValue({ allowSignup: true, minPasswordLength: 8 }) };
  const svc = new ProjectSdkAuthService(
    prisma as any, keycloak as any, {} as any, {} as any, http as any, config as any, authConfig as any, {} as any,
  );
  return { svc, keycloak, http, prisma };
}

describe('signup input (#169)', () => {
  it.each([
    ['an empty body', {}],
    ['empty strings', { email: '', password: '' }],
    ['a missing password', { email: 'a@b.co' }],
    ['an address without a domain', { email: 'nobody', password: 'longenough' }],
  ])('answers 400 for %s, without searching for the user', async (_label, body) => {
    const { svc, keycloak } = build();
    await expect(svc.signup('p1', body as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(keycloak.findUserInRealm).not.toHaveBeenCalled();
  });

  it('still reports a taken address as a conflict', async () => {
    const { svc } = build();
    await expect(svc.signup('p1', { email: 'taken@example.com', password: 'longenough' })).rejects.toThrow(
      /already registered/,
    );
  });
});

describe('signout (#169)', () => {
  it('revokes the refresh token at the realm logout endpoint', async () => {
    const { svc, http } = build();
    await expect(svc.signout('p1', 'refresh-1')).resolves.toEqual({ message: 'Signed out' });
    const [url, form] = http.post.mock.calls[0];
    expect(url).toBe('http://keycloak.test/realms/realm-p1/protocol/openid-connect/logout');
    expect(String(form)).toContain('refresh_token=refresh-1');
    expect(String(form)).toContain('client_id=realm-p1-anon');
  });

  it('needs the refresh token', async () => {
    const { svc } = build();
    await expect(svc.signout('p1', '')).rejects.toBeInstanceOf(BadRequestException);
  });
});
