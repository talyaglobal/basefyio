/**
 * The real `@supabase/supabase-js` auth client against the Nest app, over the
 * network, with Keycloak replaced by an in-memory realm that signs real RS256
 * tokens. What the test proves is the contract the SDK relies on: paths,
 * bodies, headers, error codes, session and user shapes — everything between
 * the SDK and Keycloak is the code that ships.
 *
 * Spec: docs/specs/supabase-compat-auth.md §11.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from 'crypto';

// The guard and the verifier fetch signing keys through jwks-rsa; both get the
// realm's test key. Declared before the imports (jest hoists the mock), with
// the key filled in once the pair exists.
const mockKeys = { pem: '' };
jest.mock('jwks-rsa', () => {
  const factory = () => ({ getSigningKey: async () => ({ getPublicKey: () => mockKeys.pem }) });
  return { __esModule: true, default: factory };
});

process.env.DB_CRED_ENC_KEY = process.env.DB_CRED_ENC_KEY || randomBytes(32).toString('hex');

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import * as jwt from 'jsonwebtoken';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { EmailService } from '../email/email.service';
import { RedisService } from '../redis/redis.service';
import { ProjectJwtVerifier } from '../../common/auth/project-jwt-verifier';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { ProjectSdkAuthService } from './project-sdk-auth.service';
import { ProjectMfaService } from './project-mfa.service';
import { ImportedPasswordService } from './imported-password.service';
import { SupabaseAuthCompatService } from './supabase-auth-compat.service';
import { SupabaseAuthCompatController } from './supabase-auth-compat.controller';
import { SupabaseAuthOpenController } from './supabase-auth-open.controller';
import { ProjectOAuthCallbackController } from './project-oauth-callback.controller';
import { totpCode, totpStep } from '../../common/crypto/totp';
import { rewriteSupabasePaths } from '../../common/middleware/supabase-paths.middleware';

jest.setTimeout(120_000);

// ── Fixtures ──────────────────────────────────────────────────────────────

const REALM = 'realm-p1';
const KC_URL = 'http://kc:8080';
const ISSUER = `${KC_URL}/realms/${REALM}`;
const PROJECT = { id: 'p1', name: 'Shop', keycloakRealm: REALM, anonKey: 'bf_anon_test', serviceKey: 'bf_service_test', status: 'ACTIVE' };
const APP_URL = 'http://app.test/';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
mockKeys.pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const JWK = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', use: 'sig', alg: 'RS256' };

interface RealmUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  enabled: boolean;
  firstName: string;
  lastName: string;
  createdTimestamp: number;
  attributes: Record<string, string[]>;
  password?: string;
  federated: string[];
}

/** The in-memory realm: users, sessions and the tokens it signs. */
class FakeRealm {
  users = new Map<string, RealmUser>();
  sessions = new Map<string, { userId: string; alive: boolean }>();
  codes = new Map<string, { userId: string; clientId: string }>();
  mappers = new Map<string, Set<string>>();
  redirectUris = new Map<string, Set<string>>();
  lifespan = 1800;

  findByEmail(email: string) {
    const norm = email.trim().toLowerCase();
    return [...this.users.values()].find((u) => u.email.toLowerCase() === norm || u.username === norm) ?? null;
  }

  claimsFor(user: RealmUser, clientId: string, sid: string) {
    const aal = clientId.endsWith('-aal2') ? 'aal2' : 'aal1';
    const json = (name: string) => {
      try { return JSON.parse(user.attributes[name]?.[0] ?? '{}'); } catch { return {}; }
    };
    return {
      sub: user.id,
      email: user.email,
      email_verified: user.emailVerified,
      preferred_username: user.username,
      given_name: user.firstName,
      family_name: user.lastName,
      sid,
      azp: clientId,
      typ: 'Bearer',
      scope: 'openid email profile',
      role: 'authenticated',
      aal,
      ...(aal === 'aal2' ? { amr: [{ method: 'totp' }] } : {}),
      app_metadata: json('app_metadata'),
      user_metadata: json('user_metadata'),
      ...(user.attributes.phoneNumber?.[0] ? { phone: user.attributes.phoneNumber[0] } : {}),
      ...(user.attributes.is_anonymous?.[0] === 'true' ? { is_anonymous: true } : {}),
    };
  }

  tokens(user: RealmUser, clientId: string, sid = randomBytes(8).toString('hex')) {
    if (!this.sessions.has(sid)) this.sessions.set(sid, { userId: user.id, alive: true });
    const claims = this.claimsFor(user, clientId, sid);
    const sign = (payload: Record<string, unknown>, expiresIn: number) =>
      jwt.sign(payload, privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: ISSUER, audience: ['authenticated', 'account'], expiresIn });
    return {
      access_token: sign({ ...claims, jti: randomUUID() }, this.lifespan),
      refresh_token: sign({ sub: user.id, sid, azp: clientId, typ: 'Refresh', jti: randomUUID() }, 30 * 86_400),
      expires_in: this.lifespan,
      token_type: 'Bearer',
    };
  }

  verify(token: string): Record<string, any> | null {
    try {
      return jwt.verify(token, mockKeys.pem, { algorithms: ['RS256'], issuer: ISSUER }) as Record<string, any>;
    } catch {
      return null;
    }
  }

  liveSession(token: string) {
    const claims = this.verify(token);
    if (!claims) return null;
    const s = this.sessions.get(claims.sid);
    return s?.alive ? claims : null;
  }
}

const realm = new FakeRealm();

const kcFailure = (status: number, error: string, description: string) =>
  throwError(() => ({ response: { status, data: { error, error_description: description } } }));

/** Keycloak's HTTP endpoints the SDK auth service calls directly. */
const http = {
  post: jest.fn((url: string, body: string) => {
    const params = new URLSearchParams(body);
    if (url.endsWith('/protocol/openid-connect/token')) {
      const clientId = params.get('client_id') ?? '';
      switch (params.get('grant_type')) {
        case 'password': {
          const user = realm.findByEmail(params.get('username') ?? '');
          if (!user || !user.password || user.password !== params.get('password')) {
            return kcFailure(401, 'invalid_grant', 'Invalid user credentials');
          }
          if (!user.enabled) return kcFailure(400, 'invalid_grant', 'Account disabled');
          return of({ data: realm.tokens(user, clientId) });
        }
        case 'refresh_token': {
          const claims = realm.verify(params.get('refresh_token') ?? '');
          const session = claims && realm.sessions.get(claims.sid);
          const user = claims && realm.users.get(claims.sub);
          if (!claims || !session?.alive || !user || claims.typ !== 'Refresh') {
            return kcFailure(400, 'invalid_grant', 'Token is not active');
          }
          return of({ data: realm.tokens(user, clientId, claims.sid) });
        }
        case 'authorization_code': {
          const code = realm.codes.get(params.get('code') ?? '');
          if (!code) return kcFailure(400, 'invalid_grant', 'Code not valid');
          realm.codes.delete(params.get('code')!);
          return of({ data: realm.tokens(realm.users.get(code.userId)!, code.clientId) });
        }
      }
    }
    if (url.endsWith('/protocol/openid-connect/logout')) {
      const claims = realm.verify(params.get('refresh_token') ?? '');
      if (claims) realm.sessions.get(claims.sid)!.alive = false;
      return of({ data: {} });
    }
    return kcFailure(404, 'not_found', url);
  }),
  get: jest.fn((url: string, cfg?: { headers?: Record<string, string> }) => {
    if (url.endsWith('/protocol/openid-connect/userinfo')) {
      const token = (cfg?.headers?.Authorization ?? '').replace(/^Bearer /, '');
      const claims = realm.liveSession(token);
      if (!claims) return kcFailure(401, 'invalid_token', 'Token verification failed');
      return of({ data: claims });
    }
    if (url.endsWith('/protocol/openid-connect/certs')) {
      return of({ data: { keys: [JWK, { kid: 'enc', kty: 'RSA', use: 'enc', n: 'x', e: 'AQAB' }] } });
    }
    return kcFailure(404, 'not_found', url);
  }),
};

/** The admin-client side of the realm. */
const keycloak = {
  ensureRealmClientAuthTimeMapper: jest.fn().mockResolvedValue(undefined),
  ensureRealmClientGoTrueMappers: jest.fn(async (r: string, clientId: string) => {
    realm.mappers.set(clientId, new Set(['app_metadata', 'user_metadata', 'role', 'aal']));
  }),
  ensureRealmClientDirectGrant: jest.fn().mockResolvedValue(true),
  ensureAnonClientRedirectUri: jest.fn(async (_r: string, uri: string, clientId = `${REALM}-anon`) => {
    if (!realm.redirectUris.has(clientId)) realm.redirectUris.set(clientId, new Set());
    realm.redirectUris.get(clientId)!.add(uri);
  }),
  ensureUnmanagedAttributes: jest.fn().mockResolvedValue(undefined),
  isAnonymousUser: (u: any) => u?.attributes?.is_anonymous?.[0] === 'true',
  findUserInRealm: jest.fn(async (_r: string, email: string) => realm.findByEmail(email)),
  getRealmUserRepresentation: jest.fn(async (_r: string, id: string) => realm.users.get(id) ?? null),
  getRealmUserById: jest.fn(async (_r: string, id: string) => realm.users.get(id) ?? null),
  createProjectUser: jest.fn(
    async (_r: string, data: { email: string; password?: string; firstName?: string; lastName?: string }, emailVerified: boolean, meta: any = {}) => {
      if (realm.findByEmail(data.email)) throw new Error('409 user exists');
      const id = randomUUID();
      realm.users.set(id, {
        id,
        username: data.email.toLowerCase(),
        email: data.email,
        emailVerified,
        enabled: true,
        firstName: data.firstName || data.email.split('@')[0],
        lastName: data.lastName || data.email.split('@')[0],
        createdTimestamp: Date.now(),
        attributes: {
          app_metadata: [JSON.stringify(meta.app_metadata ?? { provider: 'email', providers: ['email'] })],
          user_metadata: [JSON.stringify(meta.user_metadata ?? {})],
          ...(meta.phone ? { phoneNumber: [meta.phone] } : {}),
        },
        password: data.password,
        federated: [],
      });
      return id;
    },
  ),
  setEmailVerified: jest.fn(async (_r: string, id: string) => { realm.users.get(id)!.emailVerified = true; }),
  resetRealmUserPassword: jest.fn(async (_r: string, id: string, password: string) => { realm.users.get(id)!.password = password; }),
  clearRealmUserLoginBlockers: jest.fn().mockResolvedValue(undefined),
  userHasOtpCredential: jest.fn().mockResolvedValue(false),
  listUserFederatedIdentities: jest.fn(async (_r: string, id: string) => realm.users.get(id)?.federated ?? []),
  setRealmUserAttributes: jest.fn(async (_r: string, id: string, attrs: Record<string, string[]>) => {
    const u = realm.users.get(id);
    if (!u) throw new Error('User not found');
    for (const [k, v] of Object.entries(attrs)) {
      if (v.length === 0) delete u.attributes[k];
      else u.attributes[k] = v;
    }
  }),
  setRealmUserMetadata: jest.fn(async (_r: string, id: string, data: any, mode: 'merge' | 'replace' = 'merge') => {
    const u = realm.users.get(id);
    if (!u) throw new Error('User not found');
    const read = (name: string) => JSON.parse(u.attributes[name]?.[0] ?? '{}');
    const merge = (stored: any, patch: any) => {
      if (!patch) return stored;
      if (mode === 'replace') return { ...patch };
      const out = { ...stored };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete out[k];
        else out[k] = v;
      }
      return out;
    };
    const app_metadata = merge({ provider: 'email', providers: ['email'], ...read('app_metadata') }, data.app_metadata);
    const user_metadata = merge(read('user_metadata'), data.user_metadata);
    u.attributes.app_metadata = [JSON.stringify(app_metadata)];
    u.attributes.user_metadata = [JSON.stringify(user_metadata)];
    return { app_metadata, user_metadata };
  }),
  updateRealmUser: jest.fn(async (_r: string, id: string, data: any) => {
    const u = realm.users.get(id);
    if (!u) throw new Error('User not found');
    if (data.email !== undefined) { u.email = data.email; u.username = data.email.toLowerCase(); u.emailVerified = data.emailVerified ?? true; }
    else if (data.emailVerified !== undefined) u.emailVerified = data.emailVerified;
    if (data.enabled !== undefined) u.enabled = data.enabled;
    if (data.phoneNumber !== undefined) {
      if (data.phoneNumber) u.attributes.phoneNumber = [data.phoneNumber];
      else delete u.attributes.phoneNumber;
    }
  }),
  updateRealmUserEmail: jest.fn(async (_r: string, id: string, email: string) => {
    const u = realm.users.get(id)!;
    u.email = email; u.username = email.toLowerCase(); u.emailVerified = true;
  }),
  deleteUser: jest.fn(async (_r: string, id: string) => { realm.users.delete(id); }),
  listRealmUsersPage: jest.fn(async (_r: string, first: number, max: number) => {
    const all = [...realm.users.values()];
    return { users: all.slice(first, first + max), total: all.length };
  }),
  listUserSessions: jest.fn(async (_r: string, id: string) =>
    [...realm.sessions.entries()].filter(([, s]) => s.userId === id && s.alive).map(([sid]) => ({ id: sid })),
  ),
  revokeUserSession: jest.fn(async (_r: string, sid: string) => { const s = realm.sessions.get(sid); if (s) s.alive = false; }),
  logoutAllUserSessions: jest.fn(async (_r: string, id: string) => {
    for (const s of realm.sessions.values()) if (s.userId === id) s.alive = false;
  }),
  mintSessionForUser: jest.fn(async (_r: string, id: string, clientId: string, redirectUri: string) => {
    if (!realm.redirectUris.get(clientId)?.size) throw new Error(`redirect URI not registered on ${clientId}`);
    void redirectUri;
    const u = realm.users.get(id);
    if (!u) throw new Error('User not found');
    const t = realm.tokens(u, clientId);
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, tokenType: 'Bearer' };
  }),
};

/** A Redis with TTLs that never run out — nothing here waits long enough to matter. */
class FakeRedis {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string) { this.store.set(k, v); }
  async del(k: string) { this.store.delete(k); }
  async getdel(k: string) { const v = this.store.get(k) ?? null; this.store.delete(k); return v; }
  async incr(k: string) { const n = Number(this.store.get(k) ?? '0') + 1; this.store.set(k, String(n)); return n; }
  async expire() { /* no-op */ }
  async keys(pattern: string) { const p = pattern.replace('*', ''); return [...this.store.keys()].filter((k) => k.startsWith(p)); }
}

/** ProjectUserMfa rows, for the real MFA service. */
function fakeMfaTable() {
  const rows = new Map<string, any>();
  const key = (w: any) => `${w.projectId_keycloakUserId.projectId}:${w.projectId_keycloakUserId.keycloakUserId}`;
  return {
    findUnique: async ({ where }: any) => rows.get(key(where)) ?? null,
    findMany: async ({ where }: any) => [...rows.values()].filter((r) => r.projectId === where.projectId && (!where.verifiedAt || r.verifiedAt)),
    upsert: async ({ where, create, update }: any) => {
      const k = key(where);
      const existing = rows.get(k);
      const row = existing
        ? { ...existing, ...update }
        : { id: `f-${randomBytes(4).toString('hex')}`, recoveryCodeHashes: [], totpSecretEnc: null, pendingSecretEnc: null, pendingCreatedAt: null, verifiedAt: null, lastUsedStep: null, lastUsedAt: null, enrollmentRequiredAt: null, ...create };
      rows.set(k, row);
      return row;
    },
    update: async ({ where, data }: any) => { const row = { ...rows.get(key(where)), ...data }; rows.set(key(where), row); return row; },
    deleteMany: async ({ where }: any) => { rows.delete(`${where.projectId}:${where.keycloakUserId}`); return { count: 1 }; },
  };
}

const prisma = {
  project: {
    findFirst: jest.fn(async ({ where }: any) => {
      const keys = where?.OR?.map((o: any) => o.anonKey ?? o.serviceKey) ?? [];
      if (keys.length) return keys.includes(PROJECT.anonKey) || keys.includes(PROJECT.serviceKey) ? PROJECT : null;
      if (where?.anonKey) return where.anonKey === PROJECT.anonKey ? PROJECT : null;
      if (where?.id) return where.id === PROJECT.id ? PROJECT : null;
      return PROJECT;
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  projectUserMfa: fakeMfaTable(),
};

const authCfg: Record<string, any> = {
  allowSignup: true,
  requireEmailVerify: false,
  minPasswordLength: 6,
  tokenExpirySeconds: 1800,
  redirectUrls: [APP_URL],
  googleEnabled: true,
  mfaEnforceEnrollment: false,
  allowAnonymous: false,
};
const authConfig = { getOrCreate: async () => authCfg, getRaw: async () => authCfg };

const mails: Array<{ to: string; subject: string; html: string }> = [];
const email = { sendRawHtml: jest.fn(async (to: string, subject: string, html: string) => { mails.push({ to, subject, html }); }) };

const config = {
  get: (k: string) =>
    ({ 'keycloak.url': KC_URL, 'keycloak.publicUrl': KC_URL, publicApiUrl: 'http://localhost:4000' })[k],
};

const importedPasswords = { adoptOnSignIn: jest.fn().mockResolvedValue(false), settleForUser: jest.fn().mockResolvedValue(undefined) };

/** The link in a mail's HTML (the first href), and the six-digit code. */
function parseMail(m: { html: string }) {
  const href = m.html.match(/href="([^"]+)"/)?.[1] ?? '';
  const otp = m.html.match(/>(\d{6})</)?.[1] ?? '';
  return { href: href.replace(/&amp;/g, '&'), otp };
}

/** A mailed link is built on PUBLIC_API_URL; point it at the server under test. */
function onTestServer(href: string, base: string): string {
  const link = new URL(href);
  const server = new URL(base);
  link.protocol = server.protocol;
  link.host = server.host;
  return link.toString();
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe('GoTrue facade with @supabase/supabase-js', () => {
  let app: INestApplication;
  let base: string;
  let supabase: SupabaseClient;
  let admin: SupabaseClient;

  const client = (key: string) =>
    createClient(base, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SupabaseAuthCompatController, SupabaseAuthOpenController, ProjectOAuthCallbackController],
      providers: [
        SupabaseAuthCompatService,
        ProjectSdkAuthService,
        ProjectJwtVerifier,
        ProjectMfaService,
        { provide: PrismaService, useValue: prisma },
        { provide: KeycloakAdminService, useValue: keycloak },
        { provide: EmailService, useValue: email },
        { provide: RedisService, useValue: new FakeRedis() },
        { provide: HttpService, useValue: http },
        { provide: ConfigService, useValue: config },
        { provide: ProjectAuthConfigService, useValue: authConfig },
        { provide: ImportedPasswordService, useValue: importedPasswords },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // The same path rewrite main.ts registers: `/p/<projectId>/…` and the root service paths.
    app.use(rewriteSupabasePaths);
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    const port = (app.getHttpServer().address() as { port: number }).port;
    base = `http://127.0.0.1:${port}/api`;
    supabase = client(PROJECT.anonKey);
    admin = client(PROJECT.serviceKey);
  });

  afterAll(async () => {
    app?.getHttpServer()?.closeAllConnections?.();
    await app?.close();
  });

  const seed = (email: string, password: string, extra: Partial<RealmUser> = {}) => {
    const id = randomUUID();
    realm.users.set(id, {
      id, username: email, email, emailVerified: true, enabled: true, firstName: 'Ada', lastName: 'L', createdTimestamp: Date.now(),
      attributes: { app_metadata: [JSON.stringify({ provider: 'email', providers: ['email'], organization_id: 'org-1' })], user_metadata: [JSON.stringify({ full_name: 'Ada L' })] },
      password, federated: [], ...extra,
    });
    return id;
  };

  it('signs in with a password and returns a GoTrue session whose token carries the claims', async () => {
    const id = seed('ada@example.com', 'correct horse');
    const { data, error } = await supabase.auth.signInWithPassword({ email: 'ada@example.com', password: 'correct horse' });
    expect(error).toBeNull();
    expect(data.session).toMatchObject({ token_type: 'bearer', expires_in: 1800, refresh_token: expect.any(String) });
    expect(data.session!.expires_at).toBeGreaterThan(Date.now() / 1000);
    expect(data.user).toMatchObject({
      id,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'ada@example.com',
      app_metadata: { provider: 'email', providers: ['email'], organization_id: 'org-1' },
      user_metadata: { full_name: 'Ada L' },
    });
    const claims = JSON.parse(Buffer.from(data.session!.access_token.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ sub: id, role: 'authenticated', aal: 'aal1', app_metadata: { organization_id: 'org-1' } });
  });

  it('a wrong password is invalid_credentials', async () => {
    const { error } = await supabase.auth.signInWithPassword({ email: 'ada@example.com', password: 'nope' });
    expect(error).toMatchObject({ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' });
  });

  it('refreshes the session and the new access token verifies', async () => {
    const { data } = await supabase.auth.signInWithPassword({ email: 'ada@example.com', password: 'correct horse' });
    const { data: refreshed, error } = await supabase.auth.refreshSession({ refresh_token: data.session!.refresh_token });
    expect(error).toBeNull();
    expect(refreshed.session!.access_token).not.toBe(data.session!.access_token);
    expect(refreshed.user!.email).toBe('ada@example.com');
    const { data: userData } = await supabase.auth.getUser(refreshed.session!.access_token);
    expect(userData.user!.id).toBe(data.user!.id);
  });

  it('a refresh token that is not one is refresh_token_not_found', async () => {
    const { error } = await supabase.auth.refreshSession({ refresh_token: 'garbage' });
    expect(error).toMatchObject({ code: 'refresh_token_not_found', status: 400 });
  });

  it('getUser and updateUser work on the signed-in user; the server-side form (service key + user JWT) too', async () => {
    const { data } = await supabase.auth.signInWithPassword({ email: 'ada@example.com', password: 'correct horse' });
    const { data: me, error } = await supabase.auth.getUser();
    expect(error).toBeNull();
    expect(me.user!.email).toBe('ada@example.com');

    const { data: updated, error: updateError } = await supabase.auth.updateUser({ data: { theme: 'dark' }, password: 'new passphrase' });
    expect(updateError).toBeNull();
    expect(updated.user!.user_metadata).toMatchObject({ full_name: 'Ada L', theme: 'dark' });
    expect(realm.users.get(data.user!.id)!.password).toBe('new passphrase');
    realm.users.get(data.user!.id)!.password = 'correct horse';

    const { data: viaAdmin, error: adminErr } = await admin.auth.getUser(data.session!.access_token);
    expect(adminErr).toBeNull();
    expect(viaAdmin.user!.id).toBe(data.user!.id);

    const { error: forged } = await admin.auth.getUser('aaa.bbb.ccc');
    expect(forged).toMatchObject({ code: 'bad_jwt', status: 401 });
  });

  it('a too-short password on updateUser is weak_password with reasons', async () => {
    await supabase.auth.signInWithPassword({ email: 'ada@example.com', password: 'correct horse' });
    const { error } = await supabase.auth.updateUser({ password: 'abc' });
    expect(error).toMatchObject({ code: 'weak_password', status: 422 });
    expect((error as any).reasons).toEqual(['length']);
  });

  it('signOut ends the session: the token no longer answers getUser', async () => {
    const { data } = await supabase.auth.signInWithPassword({ email: 'ada@example.com', password: 'correct horse' });
    const token = data.session!.access_token;
    const { error } = await supabase.auth.signOut();
    expect(error).toBeNull();
    const { error: gone } = await admin.auth.getUser(token);
    expect(gone).toMatchObject({ code: 'bad_jwt', status: 401 });
  });

  it('signUp creates the user with its metadata; with confirmation off it answers a session', async () => {
    const { data, error } = await supabase.auth.signUp({
      email: 'bob@example.com',
      password: 'bob passphrase',
      options: { data: { full_name: 'Bob Builder' } },
    });
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
    expect(data.user).toMatchObject({ email: 'bob@example.com', user_metadata: { full_name: 'Bob Builder' } });
    expect(realm.findByEmail('bob@example.com')).toMatchObject({ firstName: 'Bob', lastName: 'Builder', emailVerified: true });

    const { error: dup } = await supabase.auth.signUp({ email: 'bob@example.com', password: 'bob passphrase' });
    expect(dup).toMatchObject({ code: 'user_already_exists', status: 422 });
    const { error: weak } = await supabase.auth.signUp({ email: 'cat@example.com', password: 'abc' });
    expect(weak).toMatchObject({ code: 'weak_password', status: 422 });
  });

  it('with confirmation on, signUp mails a link, sign-in says email_not_confirmed, and verifyOtp on the link signs in', async () => {
    authCfg.requireEmailVerify = true;
    mails.length = 0;
    try {
      const { data, error } = await supabase.auth.signUp({ email: 'dan@example.com', password: 'dan passphrase' });
      expect(error).toBeNull();
      expect(data.session).toBeNull();
      expect(data.user).toMatchObject({ email: 'dan@example.com', confirmation_sent_at: expect.any(String) });
      expect(data.user!.email_confirmed_at).toBeUndefined();

      const { error: unconfirmed } = await supabase.auth.signInWithPassword({ email: 'dan@example.com', password: 'dan passphrase' });
      expect(unconfirmed).toMatchObject({ code: 'email_not_confirmed', status: 400 });

      expect(mails).toHaveLength(1);
      const { href, otp } = parseMail(mails[0]);
      const link = new URL(href);
      expect(link.pathname).toBe('/api/auth/v1/verify');
      expect(link.searchParams.get('type')).toBe('signup');
      expect(link.searchParams.get('apikey')).toBe(PROJECT.anonKey);
      expect(otp).toMatch(/^\d{6}$/);

      const { data: verified, error: verifyError } = await supabase.auth.verifyOtp({ token_hash: link.searchParams.get('token')!, type: 'email' });
      expect(verifyError).toBeNull();
      expect(verified.session!.access_token).toBeDefined();
      expect(verified.user!.email_confirmed_at).toBeDefined();
      expect(realm.findByEmail('dan@example.com')!.emailVerified).toBe(true);

      const { error: reused } = await supabase.auth.verifyOtp({ token_hash: link.searchParams.get('token')!, type: 'email' });
      expect(reused).toMatchObject({ code: 'otp_expired', status: 403 });
    } finally {
      authCfg.requireEmailVerify = false;
    }
  });

  it('verifyOtp with email + the mailed code works, and a wrong code counts against the address', async () => {
    mails.length = 0;
    const { error } = await supabase.auth.resetPasswordForEmail('ada@example.com');
    expect(error).toBeNull();
    expect(mails[0].to).toBe('ada@example.com');
    const { otp } = parseMail(mails[0]);
    const { error: wrong } = await supabase.auth.verifyOtp({ email: 'ada@example.com', token: '000000', type: 'recovery' });
    expect(wrong).toMatchObject({ code: 'otp_expired' });
    const { data, error: right } = await supabase.auth.verifyOtp({ email: 'ada@example.com', token: otp, type: 'recovery' });
    expect(right).toBeNull();
    expect(data.session!.user.email).toBe('ada@example.com');
  });

  it('a magic link opened in the browser completes the PKCE flow: ?code= then exchangeCodeForSession', async () => {
    mails.length = 0;
    const pkce = client(PROJECT.anonKey);
    const { error } = await pkce.auth.signInWithOtp({ email: 'ada@example.com', options: { emailRedirectTo: `${APP_URL}welcome` } });
    expect(error).toBeNull();
    const { href } = parseMail(mails[0]);
    expect(href.startsWith('http://localhost:4000/api/auth/v1/verify?')).toBe(true);
    const res = await fetch(onTestServer(href, base), { redirect: 'manual' });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${APP_URL}welcome`);
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const { data, error: exchangeError } = await pkce.auth.exchangeCodeForSession(code!);
    expect(exchangeError).toBeNull();
    expect(data.session!.user.email).toBe('ada@example.com');

    // The client forgets its verifier after a success; the server side is single-use too.
    const twice = await fetch(`${base}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { apikey: PROJECT.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_code: code, code_verifier: 'whatever' }),
    });
    expect(twice.status).toBe(404);
    expect(await twice.json()).toMatchObject({ code: 'flow_state_not_found' });
  });

  it('signInWithOtp creates a password-less user and resend answers without complaint', async () => {
    mails.length = 0;
    const { error } = await supabase.auth.signInWithOtp({ email: 'eve@example.com', options: { data: { full_name: 'Eve' } } });
    expect(error).toBeNull();
    expect(realm.findByEmail('eve@example.com')).toMatchObject({ emailVerified: false, password: undefined, firstName: 'Eve' });
    const { error: resend } = await supabase.auth.resend({ type: 'signup', email: 'eve@example.com' });
    expect(resend).toBeNull();
  });

  it('getClaims verifies the token against the realm keys served at .well-known/jwks.json', async () => {
    const { data } = await supabase.auth.signInWithPassword({ email: 'ada@example.com', password: 'correct horse' });
    const { data: claims, error } = await supabase.auth.getClaims(data.session!.access_token);
    expect(error).toBeNull();
    expect(claims!.claims).toMatchObject({ sub: data.user!.id, role: 'authenticated', aal: 'aal1' });
    expect(claims!.header.kid).toBe('k1');

    const res = await fetch(`${base}/auth/v1/.well-known/jwks.json`, { headers: { apikey: PROJECT.anonKey } });
    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kid: 'k1', use: 'sig', kty: 'RSA' });
  });

  it('getSettings mirrors the project auth configuration', async () => {
    const res = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: PROJECT.anonKey } });
    expect(await res.json()).toMatchObject({ external: { email: true, google: true, github: false }, disable_signup: false, mailer_autoconfirm: true });
  });

  it('an anon key on an admin route is not_admin; no key is no_api_key', async () => {
    const { error } = await supabase.auth.admin.listUsers();
    expect(error).toMatchObject({ code: 'not_admin', status: 403 });
    const res = await fetch(`${base}/auth/v1/settings`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'no_api_key', error_code: 'no_api_key' });
  });

  it('admin.listUsers pages with X-Total-Count and Link, in GoTrue shape', async () => {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 2 });
    expect(error).toBeNull();
    const page = data as { users: unknown[]; total: number; nextPage: number | null; lastPage: number };
    expect(page.users).toHaveLength(2);
    expect(page.total).toBe(realm.users.size);
    expect(page.nextPage).toBe(2);
    expect(page.lastPage).toBe(Math.ceil(realm.users.size / 2));
    expect(page.users[0]).toMatchObject({ aud: 'authenticated', app_metadata: expect.any(Object) });
  });

  it('admin create / get / update / delete', async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: 'fay@example.com',
      password: 'fay passphrase',
      email_confirm: true,
      user_metadata: { full_name: 'Fay' },
      app_metadata: { organization_id: 'org-9' },
    });
    expect(error).toBeNull();
    expect(data.user).toMatchObject({ email: 'fay@example.com', app_metadata: { provider: 'email', organization_id: 'org-9' }, user_metadata: { full_name: 'Fay' } });
    expect(data.user!.email_confirmed_at).toBeDefined();

    const { error: dup } = await admin.auth.admin.createUser({ email: 'fay@example.com', password: 'x'.repeat(8) });
    expect(dup).toMatchObject({ code: 'email_exists', status: 422 });

    const { data: got } = await admin.auth.admin.getUserById(data.user!.id);
    expect(got.user!.email).toBe('fay@example.com');

    const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(data.user!.id, {
      app_metadata: { plan: 'pro' },
      ban_duration: '24h',
    });
    expect(updateError).toBeNull();
    expect(updated.user!.app_metadata).toMatchObject({ organization_id: 'org-9', plan: 'pro' });
    expect(updated.user!.banned_until).toBeDefined();
    expect(realm.users.get(data.user!.id)!.enabled).toBe(false);

    const { error: unban } = await admin.auth.admin.updateUserById(data.user!.id, { ban_duration: 'none' });
    expect(unban).toBeNull();
    expect(realm.users.get(data.user!.id)!.enabled).toBe(true);

    const { error: del } = await admin.auth.admin.deleteUser(data.user!.id);
    expect(del).toBeNull();
    expect(realm.users.has(data.user!.id)).toBe(false);
    const { error: missing } = await admin.auth.admin.getUserById(data.user!.id);
    expect(missing).toMatchObject({ code: 'user_not_found', status: 404 });
  });

  it('admin.generateLink answers the link, code and user; the link redeems', async () => {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: 'ada@example.com', options: { redirectTo: `${APP_URL}reset` } });
    expect(error).toBeNull();
    expect(data.properties).toMatchObject({
      verification_type: 'recovery',
      redirect_to: `${APP_URL}reset`,
      email_otp: expect.stringMatching(/^\d{6}$/),
      hashed_token: expect.any(String),
      action_link: expect.stringContaining('/api/auth/v1/verify?token='),
    });
    expect(data.user!.email).toBe('ada@example.com');
    const { data: session, error: verifyError } = await supabase.auth.verifyOtp({ token_hash: data.properties!.hashed_token, type: 'recovery' });
    expect(verifyError).toBeNull();
    expect(session.user!.id).toBe(data.user!.id);

    const { data: invite, error: inviteError } = await admin.auth.admin.generateLink({ type: 'invite', email: 'gil@example.com' });
    expect(inviteError).toBeNull();
    expect(invite.user).toMatchObject({ email: 'gil@example.com', invited_at: expect.any(String) });
    expect(realm.findByEmail('gil@example.com')!.password).toBeUndefined();
  });

  it('admin.inviteUserByEmail mails an invitation whose link signs the invited user in', async () => {
    mails.length = 0;
    const { data, error } = await admin.auth.admin.inviteUserByEmail('hal@example.com', { data: { full_name: 'Hal' } });
    expect(error).toBeNull();
    expect(data.user).toMatchObject({ email: 'hal@example.com', user_metadata: { full_name: 'Hal' } });
    expect(mails[0].to).toBe('hal@example.com');
    const { href } = parseMail(mails[0]);
    const token = new URL(href).searchParams.get('token')!;
    const { data: session, error: verifyError } = await supabase.auth.verifyOtp({ token_hash: token, type: 'invite' });
    expect(verifyError).toBeNull();
    expect(session.user!.email_confirmed_at).toBeDefined();
  });

  it('admin.signOut with the service key ends the session the user JWT names', async () => {
    const { data } = await supabase.auth.signInWithPassword({ email: 'ada@example.com', password: 'correct horse' });
    const { error } = await admin.auth.admin.signOut(data.session!.access_token, 'global');
    expect(error).toBeNull();
    const { error: gone } = await admin.auth.getUser(data.session!.access_token);
    expect(gone).toMatchObject({ code: 'bad_jwt' });
  });

  it('signInWithOAuth sends the browser to Keycloak with the provider and a GoTrue state; the callback answers a PKCE code', async () => {
    const pkce = client(PROJECT.anonKey);
    const { data, error } = await pkce.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${APP_URL}oauth`, skipBrowserRedirect: true },
    });
    expect(error).toBeNull();
    const authorize = new URL(data.url!);
    expect(authorize.pathname).toBe('/api/auth/v1/authorize');
    expect(authorize.searchParams.get('provider')).toBe('google');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();

    // The browser follows it: no apikey header, the project named by the path prefix.
    const res = await fetch(`${base}/p/${PROJECT.id}${authorize.pathname.replace(/^\/api/, '')}${authorize.search}`, {
      redirect: 'manual',
      headers: { 'x-bf-project': PROJECT.id },
    });
    expect(res.status).toBe(302);
    const kc = new URL(res.headers.get('location')!);
    expect(kc.pathname).toBe(`/realms/${REALM}/protocol/openid-connect/auth`);
    expect(kc.searchParams.get('kc_idp_hint')).toBe('google');
    const state = JSON.parse(Buffer.from(kc.searchParams.get('state')!, 'base64url').toString());
    expect(state).toMatchObject({ gotrue: true, redirectTo: `${APP_URL}oauth`, codeChallenge: authorize.searchParams.get('code_challenge') });

    // Keycloak comes back with a code for an existing user.
    const ada = realm.findByEmail('ada@example.com')!;
    realm.codes.set('kc-code-1', { userId: ada.id, clientId: `${REALM}-anon` });
    const callback = await fetch(`${base}/rest/v1/auth/callback/${PROJECT.id}/google?code=kc-code-1&state=${kc.searchParams.get('state')}`, { redirect: 'manual' });
    expect(callback.status).toBe(302);
    const landed = new URL(callback.headers.get('location')!);
    expect(landed.origin + landed.pathname).toBe(`${APP_URL}oauth`);
    const { data: session, error: exchangeError } = await pkce.auth.exchangeCodeForSession(landed.searchParams.get('code')!);
    expect(exchangeError).toBeNull();
    expect(session.user!.app_metadata.providers).toEqual(['email', 'google']);
    expect(session.user!.identities!.map((i) => i.provider)).toContain('google');
  });

  it('linkedin_oidc is Keycloak\'s linkedin', async () => {
    const res = await fetch(`${base}/auth/v1/authorize?provider=linkedin_oidc&apikey=${PROJECT.anonKey}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('kc_idp_hint')).toBe('linkedin');
  });

  it('MFA: enroll, challenge, verify to aal2; sign-in stays aal1 until the step-up; unenroll needs aal2', async () => {
    const mfaClient = client(PROJECT.anonKey);
    await mfaClient.auth.signInWithPassword({ email: 'bob@example.com', password: 'bob passphrase' });

    const { data: factor, error: enrollError } = await mfaClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'phone' });
    expect(enrollError).toBeNull();
    expect(factor).toMatchObject({ type: 'totp', friendly_name: 'phone', totp: { secret: expect.any(String), uri: expect.stringContaining('otpauth://totp/') } });
    expect(factor!.totp.qr_code).toMatch(/^data:image\/svg\+xml;utf-8,<svg/);

    const { data: challenge, error: challengeError } = await mfaClient.auth.mfa.challenge({ factorId: factor!.id });
    expect(challengeError).toBeNull();
    const code = totpCode(factor!.totp.secret, totpStep());
    const { data: stepped, error: verifyError } = await mfaClient.auth.mfa.verify({ factorId: factor!.id, challengeId: challenge!.id, code });
    expect(verifyError).toBeNull();
    expect(stepped!.user.factors).toEqual([expect.objectContaining({ factor_type: 'totp', status: 'verified' })]);
    const { data: aal } = await mfaClient.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal).toMatchObject({ currentLevel: 'aal2', nextLevel: 'aal2' });

    // A fresh sign-in is aal1 with aal2 as the next level; the parked challenge steps it up.
    const again = client(PROJECT.anonKey);
    const { error: signInError } = await again.auth.signInWithPassword({ email: 'bob@example.com', password: 'bob passphrase' });
    expect(signInError).toBeNull();
    const { data: level } = await again.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(level).toMatchObject({ currentLevel: 'aal1', nextLevel: 'aal2' });
    const { data: ch2 } = await again.auth.mfa.challenge({ factorId: factor!.id });
    const { error: wrongCode } = await again.auth.mfa.verify({ factorId: factor!.id, challengeId: ch2!.id, code: '000000' });
    expect(wrongCode).toMatchObject({ code: 'mfa_verification_failed' });
    const { data: stepped2, error: verify2 } = await again.auth.mfa.verify({
      factorId: factor!.id, challengeId: ch2!.id, code: totpCode(factor!.totp.secret, totpStep() + 1),
    });
    expect(verify2).toBeNull();
    const claims = JSON.parse(Buffer.from(stepped2!.access_token.split('.')[1], 'base64url').toString());
    expect(claims.aal).toBe('aal2');

    const { error: unenrollError } = await again.auth.mfa.unenroll({ factorId: factor!.id });
    expect(unenrollError).toBeNull();
    const { data: after } = await again.auth.getUser();
    expect(after.user!.factors).toEqual([]);
  });
});
