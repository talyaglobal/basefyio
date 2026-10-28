/**
 * The platform's exceptions in GoTrue's vocabulary (docs/specs/supabase-compat-auth.md §3),
 * and the shapes gotrue-js reads (§4).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { GoTrueError, GoTrueExceptionFilter, translate } from './supabase-auth-compat.filter';
import {
  buildUser,
  decodeJwtPayload,
  linkTypeMatches,
  mapProviderName,
  namesFromMetadata,
  pkceChallenge,
  toSession,
} from './gotrue-shapes';
import { parseGoDuration, withFragment, withQuery } from './supabase-auth-compat.service';

function run(exception: unknown) {
  const res: any = {
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    statusCode: 0,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const host: any = { switchToHttp: () => ({ getResponse: () => res }) };
  new GoTrueExceptionFilter().catch(exception, host);
  return res;
}

describe('translate', () => {
  it.each([
    [401, 'Invalid email or password', undefined, 400, 'invalid_credentials', 'Invalid login credentials'],
    [401, 'This account uses an authenticator app.', 'totp_required', 400, 'mfa_verification_failed', 'MFA verification failed'],
    [409, 'Email already registered', undefined, 422, 'user_already_exists', 'User already registered'],
    [409, 'User already exists in this project', undefined, 422, 'email_exists', 'A user with this email address has already been registered'],
    [400, 'Password must be at least 8 characters', undefined, 422, 'weak_password', 'Password should be at least 8 characters.'],
    [403, 'Self-signup is disabled for this project', undefined, 422, 'signup_disabled', 'Signups not allowed for this instance'],
    [401, 'Invalid or expired refresh token', undefined, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found'],
    [401, 'Missing apikey', undefined, 401, 'no_api_key', 'No API key found in request'],
    [401, 'Invalid API key', undefined, 401, 'no_api_key', 'No API key found in request'],
    [401, 'Invalid or expired access token', undefined, 401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature'],
    [403, 'This route requires the service key and must be called from your server', undefined, 403, 'not_admin', 'User not allowed'],
    [403, 'This route requires a signed-in user.', undefined, 401, 'no_authorization', 'This endpoint requires a Bearer token'],
    [404, 'Project not found', undefined, 404, 'not_found', 'Project not found'],
    [503, 'Keycloak impersonation is unavailable', undefined, 503, 'unexpected_failure', 'Keycloak impersonation is unavailable'],
  ])('%s "%s" (%s) → %s %s', (status, message, code, wantStatus, wantCode, wantMsg) => {
    expect(translate(status, message, code)).toMatchObject({ status: wantStatus, code: wantCode, msg: wantMsg });
  });

  it('weak_password carries the reasons gotrue-js reads', () => {
    expect(translate(400, 'Password must be at least 6 characters').weak_password).toEqual({ reasons: ['length'] });
  });

  it('keeps a code a handler attached', () => {
    expect(translate(422, 'nope', 'custom_code')).toMatchObject({ status: 422, code: 'custom_code' });
  });
});

describe('GoTrueExceptionFilter', () => {
  it('answers with the api version header and both the new and the legacy field names', () => {
    const res = run(new UnauthorizedException('Invalid email or password'));
    expect(res.statusCode).toBe(400);
    expect(res.headers['X-Supabase-Api-Version']).toBe('2024-01-01');
    expect(res.body).toEqual({
      code: 'invalid_credentials',
      error_code: 'invalid_credentials',
      msg: 'Invalid login credentials',
      message: 'Invalid login credentials',
    });
  });

  it('passes a GoTrueError through as thrown', () => {
    const res = run(new GoTrueError(403, 'otp_expired', 'Email link is invalid or has expired'));
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'otp_expired', msg: 'Email link is invalid or has expired' });
  });

  it('includes weak_password reasons', () => {
    const res = run(new GoTrueError(422, 'weak_password', 'Password should be at least 6 characters.', { reasons: ['length'] }));
    expect(res.body).toMatchObject({ code: 'weak_password', weak_password: { reasons: ['length'] } });
  });

  it('maps the exceptions the sign-up service throws', () => {
    expect(run(new ConflictException('Email already registered')).body).toMatchObject({ code: 'user_already_exists' });
    expect(run(new ForbiddenException('Self-signup is disabled for this project')).body).toMatchObject({ code: 'signup_disabled' });
    expect(run(new BadRequestException('Password must be at least 6 characters')).statusCode).toBe(422);
  });

  it('hides the detail of an unexpected error', () => {
    const res = run(new Error('pg: connection refused'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'unexpected_failure', msg: 'Internal server error' });
  });

  it('a handler-attached code survives on a plain HttpException', () => {
    const res = run(new UnauthorizedException({ message: 'This sign-in challenge has expired. Sign in again.', code: 'challenge_expired' }));
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'mfa_challenge_expired' });
  });
});

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeJwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256', kid: 'k' })}.${b64url(claims)}.sig`;

describe('shapes', () => {
  it('toSession reads expires_at from the token and names the type bearer', () => {
    const user = buildUser({ id: 'u1', email: 'ada@example.com', emailVerified: true, createdTimestamp: 1700000000000 });
    const s = toSession({ accessToken: makeJwt({ sub: 'u1', exp: 1700001800 }), refreshToken: 'r', expiresIn: 1800 }, user);
    expect(s).toMatchObject({ access_token: expect.any(String), token_type: 'bearer', expires_in: 1800, expires_at: 1700001800, refresh_token: 'r' });
    expect(s.user.id).toBe('u1');
  });

  it('buildUser reads the metadata attributes, identities and confirmation from the representation', () => {
    const user = buildUser(
      {
        id: 'u1',
        email: 'ada@example.com',
        emailVerified: true,
        createdTimestamp: Date.parse('2026-01-02T03:04:05Z'),
        attributes: {
          app_metadata: ['{"provider":"email","providers":["email"],"organization_id":"org-1"}'],
          user_metadata: ['{"full_name":"Ada"}'],
          phoneNumber: ['+905551112233'],
          last_sign_in_at: ['2026-02-01T00:00:00.000Z'],
        },
      },
      { providers: ['google'], factors: [] },
    );
    expect(user).toMatchObject({
      id: 'u1',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'ada@example.com',
      email_confirmed_at: '2026-01-02T03:04:05.000Z',
      confirmed_at: '2026-01-02T03:04:05.000Z',
      phone: '+905551112233',
      last_sign_in_at: '2026-02-01T00:00:00.000Z',
      app_metadata: { provider: 'email', providers: ['email', 'google'], organization_id: 'org-1' },
      user_metadata: { full_name: 'Ada', email: 'ada@example.com', email_verified: true, sub: 'u1' },
      created_at: '2026-01-02T03:04:05.000Z',
      is_anonymous: false,
      factors: [],
    });
    expect(user.identities.map((i) => i.provider)).toEqual(['email', 'google']);
  });

  it('buildUser without attributes still answers in shape, unconfirmed and with default metadata', () => {
    const user = buildUser({ id: 'u2', email: 'bob@example.com', emailVerified: false });
    expect(user.email_confirmed_at).toBeUndefined();
    expect(user.app_metadata).toEqual({ provider: 'email', providers: ['email'] });
    expect(user.phone).toBe('');
    expect(user.identities).toHaveLength(1);
  });

  it('an anonymous user has no email identity and says so', () => {
    const user = buildUser({ id: 'a1', email: 'anon_x@anonymous.invalid', attributes: { is_anonymous: ['true'] } });
    expect(user.is_anonymous).toBe(true);
    expect(user.email).toBeUndefined();
    expect(user.identities).toEqual([]);
  });

  it('a ban in the future is reported, a past one is not', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(buildUser({ id: 'u', attributes: { banned_until: [future] } }).banned_until).toBe(future);
    expect(buildUser({ id: 'u', attributes: { banned_until: ['2000-01-01T00:00:00.000Z'] } }).banned_until).toBeUndefined();
  });

  it('decodeJwtPayload tolerates non-JWTs', () => {
    expect(decodeJwtPayload('nope')).toBeNull();
    expect(decodeJwtPayload(undefined)).toBeNull();
    expect(decodeJwtPayload(makeJwt({ sub: 'x' }))).toEqual({ sub: 'x' });
  });

  it('maps supabase-js provider names to Keycloak aliases', () => {
    expect(mapProviderName('linkedin_oidc')).toBe('linkedin');
    expect(mapProviderName('azure')).toBe('microsoft');
    expect(mapProviderName('google')).toBe('google');
  });

  it('pkceChallenge matches what gotrue-js computes', () => {
    expect(pkceChallenge('verifier', 'plain')).toBe('verifier');
    expect(pkceChallenge('verifier', 's256')).toBe(require('crypto').createHash('sha256').update('verifier').digest('base64url'));
  });

  it('linkTypeMatches accepts the aliases GoTrue accepts', () => {
    expect(linkTypeMatches('email', 'signup')).toBe(true);
    expect(linkTypeMatches('email', 'magiclink')).toBe(true);
    expect(linkTypeMatches('email', 'recovery')).toBe(false);
    expect(linkTypeMatches('recovery', 'recovery')).toBe(true);
    expect(linkTypeMatches('email_change_new', 'email_change')).toBe(true);
    expect(linkTypeMatches('invite', 'signup')).toBe(false);
  });

  it('namesFromMetadata reads the names Supabase apps store', () => {
    expect(namesFromMetadata({ full_name: 'Ada Lovelace' })).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(namesFromMetadata({ first_name: 'Ada', last_name: 'L' })).toEqual({ firstName: 'Ada', lastName: 'L' });
    expect(namesFromMetadata({})).toEqual({ firstName: undefined, lastName: undefined });
  });

  it('withQuery and withFragment keep the target intact', () => {
    expect(withQuery('https://app/cb', { code: 'x' })).toBe('https://app/cb?code=x');
    expect(withQuery('https://app/cb?a=1', { code: 'x' })).toBe('https://app/cb?a=1&code=x');
    expect(withFragment('https://app/cb#old', { access_token: 't' })).toBe('https://app/cb#access_token=t');
  });

  it('parseGoDuration reads the durations GoTrue accepts', () => {
    expect(parseGoDuration('24h')).toBe(86_400_000);
    expect(parseGoDuration('1h30m')).toBe(5_400_000);
    expect(parseGoDuration('876600h')).toBe(876_600 * 3_600_000);
    expect(parseGoDuration('30')).toBeNull();
    expect(parseGoDuration('none')).toBeNull();
  });
});
