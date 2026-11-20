/**
 * #242 — an anonymous session's access token must open the same doors a signed-in user's does.
 *
 * The token comes from signInAnonymously: RS256, issued by the project realm to its
 * `<realm>-anon` client, `is_anonymous: true`, no `role` claim. These tests run the guard's
 * real verifier (jsonwebtoken + the JWKS client), with only the key fetch stubbed, so a broken
 * import or a claim the verifier wrongly insists on shows up as a 401 here.
 */
import { generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { UnauthorizedException } from '@nestjs/common';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KID = 'kid-1';

jest.mock('jwks-rsa', () => ({
  JwksClient: jest.fn().mockImplementation(() => ({
    getSigningKey: jest.fn(async (kid: string) => {
      if (kid !== KID) throw new Error('unknown kid');
      return { getPublicKey: () => PUBLIC_PEM };
    }),
  })),
}));

import { ApiKeyGuard } from './api-key.guard';

const REALM = 'bf-demo';
const PUBLIC_URL = 'https://auth.example.test';
const PROJECT = { id: 'p1', anonKey: 'anon-key', serviceKey: 'svc-key', keycloakRealm: REALM, status: 'ACTIVE' };
const config = {
  get: jest.fn((k: string) => (k === 'keycloak.publicUrl' ? PUBLIC_URL : k === 'keycloak.url' ? 'http://kc:8080' : undefined)),
} as any;
const guard = (scope?: string) =>
  new ApiKeyGuard(
    { project: { findFirst: jest.fn().mockResolvedValue(PROJECT) } } as any,
    config,
    { getAllAndOverride: jest.fn().mockReturnValue(scope) } as any,
  );

function ctx(token: string) {
  const req: any = { headers: { apikey: 'anon-key', authorization: `Bearer ${token}` } };
  return {
    req,
    context: {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as any,
  };
}

/** The shape signInAnonymously hands out (#242 report: exp-iat=1800, azp=<realm>-anon, no role). */
function anonymousToken(overrides: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) {
  return jwt.sign(
    {
      sub: '5f0c7c1e-1111-4222-8333-944455556666',
      azp: `${REALM}-anon`,
      typ: 'Bearer',
      preferred_username: 'anon_0123456789abcdef01234567',
      is_anonymous: true,
      scope: 'openid email profile',
      ...overrides,
    },
    privateKey,
    { algorithm: 'RS256', keyid: KID, issuer: `${PUBLIC_URL}/realms/${REALM}`, expiresIn: 1800, ...opts },
  );
}

describe('ApiKeyGuard — anonymous session tokens (#242)', () => {
  it('admits the token as an authenticated end user (REST, /auth/me)', async () => {
    const { context, req } = ctx(anonymousToken());
    await expect(guard().canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload.dbRole).toBe('authenticated');
    expect(req.apiKeyPayload.jwtClaims.sub).toBe('5f0c7c1e-1111-4222-8333-944455556666');
    expect(req.apiKeyPayload.jwtClaims.is_anonymous).toBe(true);
  });

  it("publishes role 'authenticated' so auth.jwt() ->> 'role' is not NULL", async () => {
    const { context, req } = ctx(anonymousToken());
    await guard().canActivate(context);
    expect(req.apiKeyPayload.jwtClaims.role).toBe('authenticated');
  });

  it('keeps a role claim the realm already set', async () => {
    const { context, req } = ctx(anonymousToken({ role: 'authenticated', aal: 'aal1' }));
    await guard().canActivate(context);
    expect(req.apiKeyPayload.jwtClaims.role).toBe('authenticated');
    expect(req.apiKeyPayload.jwtClaims.aal).toBe('aal1');
  });

  it("passes routes marked 'authenticated' (MFA, anonymous/upgrade)", async () => {
    const { context, req } = ctx(anonymousToken());
    await expect(guard('authenticated').canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload.dbRole).toBe('authenticated');
  });

  it('still refuses an expired anonymous token', async () => {
    const { context } = ctx(anonymousToken({}, { expiresIn: -10 }));
    await expect(guard().canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still refuses a token from another realm', async () => {
    const { context } = ctx(anonymousToken({}, { issuer: `${PUBLIC_URL}/realms/other` }));
    await expect(guard().canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still refuses a token signed with another key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = jwt.sign({ sub: 'x', is_anonymous: true }, other, {
      algorithm: 'RS256', keyid: KID, issuer: `${PUBLIC_URL}/realms/${REALM}`, expiresIn: 1800,
    });
    const { context } = ctx(forged);
    await expect(guard().canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
