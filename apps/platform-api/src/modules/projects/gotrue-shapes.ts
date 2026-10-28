/**
 * The wire shapes of GoTrue (Supabase Auth), built from what Keycloak knows
 * about a user. Pure functions: everything here can be tested without a realm.
 *
 * Spec: docs/specs/supabase-compat-auth.md §4.
 */
import { createHash } from 'crypto';

/** The subset of a Keycloak user representation the shapes read. */
export interface KeycloakUserRep {
  id?: string;
  username?: string;
  email?: string;
  emailVerified?: boolean;
  enabled?: boolean;
  firstName?: string;
  lastName?: string;
  createdTimestamp?: number;
  attributes?: Record<string, unknown>;
}

export interface GoTrueTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType?: string;
}

export interface GoTrueFactor {
  id: string;
  factor_type: 'totp';
  friendly_name?: string;
  status: 'verified' | 'unverified';
  created_at: string;
  updated_at: string;
}

export interface GoTrueIdentity {
  identity_id: string;
  id: string;
  user_id: string;
  identity_data: Record<string, unknown>;
  provider: string;
  last_sign_in_at?: string;
  created_at: string;
  updated_at: string;
  email?: string;
}

export interface GoTrueUser {
  id: string;
  aud: 'authenticated';
  role: 'authenticated';
  email?: string;
  email_confirmed_at?: string;
  confirmed_at?: string;
  phone: string;
  phone_confirmed_at?: string;
  last_sign_in_at?: string;
  confirmation_sent_at?: string;
  recovery_sent_at?: string;
  new_email?: string;
  invited_at?: string;
  banned_until?: string;
  app_metadata: Record<string, unknown> & { provider: string; providers: string[] };
  user_metadata: Record<string, unknown>;
  identities: GoTrueIdentity[];
  factors?: GoTrueFactor[];
  created_at: string;
  updated_at: string;
  is_anonymous: boolean;
}

export interface GoTrueSession {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at?: number;
  refresh_token: string;
  user: GoTrueUser;
}

/** Claims of a token, read without verification. Null for anything that is not a JWT. */
export function decodeJwtPayload(token: string | undefined | null): Record<string, unknown> | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function toSession(tokens: GoTrueTokens, user: GoTrueUser): GoTrueSession {
  const exp = decodeJwtPayload(tokens.accessToken)?.exp;
  const expiresIn = Number(tokens.expiresIn) || 0;
  return {
    access_token: tokens.accessToken,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: typeof exp === 'number' ? exp : Math.floor(Date.now() / 1000) + expiresIn,
    refresh_token: tokens.refreshToken,
    user,
  };
}

/** First value of a Keycloak attribute (they are lists), or undefined. */
export function readAttribute(rep: KeycloakUserRep | null | undefined, name: string): string | undefined {
  const raw = rep?.attributes?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The JSON document in an attribute, `{}` when absent or not an object. */
export function readJsonAttribute(rep: KeycloakUserRep | null | undefined, name: string): Record<string, unknown> {
  const text = readAttribute(rep, name);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isAnonymousRep(rep: KeycloakUserRep | null | undefined): boolean {
  return readAttribute(rep, 'is_anonymous') === 'true';
}

function isoFromMillis(ms: number | undefined): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * A GoTrue user from a full Keycloak representation (`users.findOne`, attributes included).
 * `providers` are the identity-provider aliases the user has linked; `factors` what the MFA
 * service knows. The email identity comes first, as GoTrue orders them.
 */
export function buildUser(
  rep: KeycloakUserRep,
  extra: { providers?: string[]; factors?: GoTrueFactor[] } = {},
): GoTrueUser {
  const id = rep.id ?? '';
  const createdAt = isoFromMillis(rep.createdTimestamp) ?? new Date(0).toISOString();
  const updatedAt = readAttribute(rep, 'updated_at') ?? createdAt;
  const anonymous = isAnonymousRep(rep);
  const email = anonymous ? undefined : rep.email || undefined;
  const confirmedAt = rep.emailVerified ? readAttribute(rep, 'email_confirmed_at') ?? createdAt : undefined;

  const storedApp = readJsonAttribute(rep, 'app_metadata');
  const linked = (extra.providers ?? []).map(mapProviderName);
  const storedProviders = Array.isArray(storedApp.providers)
    ? (storedApp.providers as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const providers = Array.from(new Set([...(storedProviders.length ? storedProviders : ['email']), ...linked]));
  const provider = typeof storedApp.provider === 'string' && storedApp.provider ? storedApp.provider : providers[0];
  const app_metadata = { ...storedApp, provider, providers };

  const storedUser = readJsonAttribute(rep, 'user_metadata');
  const user_metadata: Record<string, unknown> = {
    ...(email ? { email, email_verified: !!rep.emailVerified } : {}),
    phone_verified: readAttribute(rep, 'phoneVerified') === 'true',
    sub: id,
    ...storedUser,
  };

  const identities: GoTrueIdentity[] = [];
  if (email) {
    identities.push({
      identity_id: id,
      id,
      user_id: id,
      identity_data: { email, email_verified: !!rep.emailVerified, phone_verified: false, sub: id },
      provider: 'email',
      last_sign_in_at: readAttribute(rep, 'last_sign_in_at'),
      created_at: createdAt,
      updated_at: updatedAt,
      email,
    });
  }
  for (const alias of linked) {
    identities.push({
      identity_id: `${id}:${alias}`,
      id,
      user_id: id,
      identity_data: { ...(email ? { email } : {}), sub: id },
      provider: alias,
      last_sign_in_at: readAttribute(rep, 'last_sign_in_at'),
      created_at: createdAt,
      updated_at: updatedAt,
      email,
    });
  }

  const bannedUntil = readAttribute(rep, 'banned_until');
  const banned = bannedUntil && Date.parse(bannedUntil) > Date.now() ? bannedUntil : undefined;
  const phone = readAttribute(rep, 'phoneNumber') ?? '';

  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: confirmedAt,
    confirmed_at: confirmedAt,
    phone,
    phone_confirmed_at: phone && readAttribute(rep, 'phoneVerified') === 'true' ? createdAt : undefined,
    last_sign_in_at: readAttribute(rep, 'last_sign_in_at'),
    invited_at: readAttribute(rep, 'invited_at'),
    ...(banned ? { banned_until: banned } : {}),
    app_metadata,
    user_metadata,
    identities,
    factors: extra.factors ?? [],
    created_at: createdAt,
    updated_at: updatedAt,
    is_anonymous: anonymous,
  };
}

/**
 * supabase-js names some providers differently from Keycloak's identity-provider aliases.
 * Unknown names pass through unchanged.
 */
export function mapProviderName(name: string): string {
  const map: Record<string, string> = { linkedin_oidc: 'linkedin', azure: 'microsoft', 'linkedin-openid': 'linkedin' };
  return map[name] ?? name;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The PKCE challenge a verifier must match, by method. */
export function pkceChallenge(verifier: string, method: 's256' | 'plain' = 's256'): string {
  if (method === 'plain') return verifier;
  return createHash('sha256').update(verifier).digest('base64url');
}

/** The one-time-link types GoTrue knows, and what each one proves. */
export type GoTrueLinkType = 'signup' | 'magiclink' | 'recovery' | 'invite' | 'email_change';

/** What `type` a client may send to redeem a stored link of `stored` type. */
export function linkTypeMatches(requested: string, stored: GoTrueLinkType): boolean {
  if (requested === stored) return true;
  if (requested === 'email') return stored === 'signup' || stored === 'magiclink' || stored === 'invite';
  if (requested === 'email_change_current' || requested === 'email_change_new') return stored === 'email_change';
  return false;
}

/** Names from GoTrue-style metadata, for Keycloak's required first/last name. */
export function namesFromMetadata(
  data: Record<string, unknown> | undefined,
): { firstName?: string; lastName?: string } {
  if (!data) return {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const full = str(data.full_name) || str(data.name);
  const firstName = str(data.first_name) || str(data.given_name) || full.split(' ')[0] || undefined;
  const lastName =
    str(data.last_name) || str(data.family_name) || (full ? full.split(' ').slice(1).join(' ') : '') || undefined;
  return { firstName, lastName };
}
