import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt } from 'crypto';
import * as QRCode from 'qrcode';
import {
  AssuranceLevel,
  KeycloakAdminService,
  MintedTokens,
  realmPublicClientId,
} from '../auth/keycloak-admin.service';
import { RedisService } from '../redis/redis.service';
import { ProjectJwtVerifier } from '../../common/auth/project-jwt-verifier';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { ProjectSdkAuthService, EmailType, OAuthStateExtras } from './project-sdk-auth.service';
import { ProjectMfaService } from './project-mfa.service';
import { ImportedPasswordService } from './imported-password.service';
import { resolveOAuthRedirect } from './oauth-redirect.util';
import { GoTrueError } from './supabase-auth-compat.filter';
import {
  GoTrueFactor,
  GoTrueLinkType,
  GoTrueSession,
  GoTrueTokens,
  GoTrueUser,
  buildUser,
  decodeJwtPayload,
  linkTypeMatches,
  mapProviderName,
  namesFromMetadata,
  pkceChallenge,
  readJsonAttribute,
  sha256Hex,
  toSession,
} from './gotrue-shapes';

/**
 * GoTrue (Supabase Auth) over a project's Keycloak realm — what
 * `@supabase/supabase-js` talks to at `/api/auth/v1/*`.
 *
 * Nothing here is a second auth system. Passwords are checked, tokens minted
 * and sessions ended by the same calls the SDK routes under `/rest/v1/auth` make
 * (ProjectSdkAuthService); what this adds is GoTrue's vocabulary — its request
 * and response shapes, its error codes, its one-time links — and the two things
 * those routes never needed: a session for a user who has not typed a password
 * (a mailed link, an invitation, a step-up), and the claims a Supabase app reads
 * from the token. Spec: docs/specs/supabase-compat-auth.md.
 */

type Project = { id: string; name: string; keycloakRealm: string; anonKey: string };

/** One-time link, stored under the hash of the token the link carries. */
interface StoredLink {
  type: GoTrueLinkType;
  userId: string;
  email: string;
  redirectTo: string;
  codeChallenge?: string;
  codeChallengeMethod?: 's256' | 'plain';
  newEmail?: string;
  otp: string;
  eotpKey: string;
  createdAt: number;
}

/** A PKCE flow waiting for its verifier (`POST /token?grant_type=pkce`). */
interface StoredFlow {
  userId: string;
  tokens?: GoTrueTokens;
  codeChallenge: string;
  codeChallengeMethod: 's256' | 'plain';
  type: string;
  aal?: AssuranceLevel;
}

export interface IssuedLink {
  hashed_token: string;
  email_otp: string;
  action_link: string;
  redirect_to: string;
  verification_type: GoTrueLinkType;
}

/** Seconds a link of each type stays valid. */
const LINK_TTL: Record<GoTrueLinkType, number> = {
  signup: 86_400,
  magiclink: 3_600,
  recovery: 3_600,
  invite: 7 * 86_400,
  email_change: 3_600,
};

const LINK_MAIL: Record<GoTrueLinkType, EmailType> = {
  signup: 'verify',
  magiclink: 'magic_link',
  recovery: 'reset',
  invite: 'invite',
  email_change: 'change_email',
};

/** Wrong `email` + `token` pairs allowed per address and type before the link is refused. */
const OTP_ATTEMPT_LIMIT = 5;
const OTP_ATTEMPT_WINDOW_SECONDS = 900;
const FLOW_TTL_SECONDS = 300;
const ENROLL_CHALLENGE_TTL_SECONDS = 300;

const SUPPORTED_PROVIDERS = ['google', 'microsoft', 'apple', 'github', 'gitlab', 'linkedin', 'facebook', 'twitter'];

@Injectable()
export class SupabaseAuthCompatService {
  private readonly logger = new Logger(SupabaseAuthCompatService.name);

  constructor(
    private readonly sdkAuth: ProjectSdkAuthService,
    private readonly keycloak: KeycloakAdminService,
    private readonly mfa: ProjectMfaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly authConfig: ProjectAuthConfigService,
    private readonly verifier: ProjectJwtVerifier,
    private readonly importedPasswords: ImportedPasswordService,
  ) {}

  // ── Keys ────────────────────────────────────────────────────────────────

  private tokKey(projectId: string, rawToken: string) {
    return `gotrue_tok:${projectId}:${sha256Hex(rawToken)}`;
  }
  private eotpKey(projectId: string, type: string, email: string) {
    return `gotrue_eotp:${projectId}:${type}:${email.trim().toLowerCase()}`;
  }
  private eotpAttemptsKey(projectId: string, type: string, email: string) {
    return `gotrue_eotp_attempts:${projectId}:${type}:${email.trim().toLowerCase()}`;
  }
  private flowKey(projectId: string, code: string) {
    return `gotrue_flow:${projectId}:${code}`;
  }
  private pendingMfaKey(projectId: string, userId: string) {
    return `gotrue_mfa_pending:${projectId}:${userId}`;
  }
  private enrollChallengeKey(projectId: string, challengeId: string) {
    return `gotrue_enroll_challenge:${projectId}:${challengeId}`;
  }

  // ── Users and sessions ──────────────────────────────────────────────────

  getProject(projectId: string): Promise<Project> {
    return this.sdkAuth.getProject(projectId);
  }

  /** The GoTrue user behind a realm user id; 404 when the realm has no such user. */
  async userById(project: Project, userId: string): Promise<GoTrueUser> {
    const rep = await this.keycloak.getRealmUserRepresentation(project.keycloakRealm, userId);
    if (!rep?.id) throw new GoTrueError(404, 'user_not_found', 'User not found');
    const [providers, factors] = await Promise.all([
      this.keycloak.listUserFederatedIdentities(project.keycloakRealm, userId).catch(() => [] as string[]),
      this.factorsFor(project.id, userId),
    ]);
    return buildUser(rep as any, { providers, factors });
  }

  private async factorsFor(projectId: string, userId: string): Promise<GoTrueFactor[]> {
    const row = await this.mfa.getState(projectId, userId).catch(() => null);
    if (!row) return [];
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : new Date().toISOString());
    if (row.verifiedAt) {
      return [
        {
          id: row.id,
          factor_type: 'totp',
          friendly_name: 'Authenticator app',
          status: 'verified',
          created_at: iso(row.verifiedAt),
          updated_at: iso(row.lastUsedAt ?? row.verifiedAt),
        },
      ];
    }
    if (row.pendingSecretEnc) {
      return [
        {
          id: row.id,
          factor_type: 'totp',
          friendly_name: 'Authenticator app',
          status: 'unverified',
          created_at: iso(row.pendingCreatedAt),
          updated_at: iso(row.pendingCreatedAt),
        },
      ];
    }
    return [];
  }

  /** A session from tokens Keycloak just issued; the user is read fresh so its claims and metadata agree. */
  private async sessionFromTokens(project: Project, tokens: GoTrueTokens): Promise<GoTrueSession> {
    const sub = decodeJwtPayload(tokens.accessToken)?.sub;
    if (typeof sub !== 'string' || !sub) throw new GoTrueError(500, 'unexpected_failure', 'Token without a subject');
    this.touchLastSignIn(project, sub);
    return toSession(tokens, await this.userById(project, sub));
  }

  /** Best-effort `last_sign_in_at`, so the user object can say when they last signed in. */
  private touchLastSignIn(project: Project, userId: string): void {
    void this.keycloak
      .setRealmUserAttributes(project.keycloakRealm, userId, { last_sign_in_at: [new Date().toISOString()] })
      .catch(() => undefined);
  }

  /**
   * Tokens for a user without a password: a redeemed link, an invitation, a step-up.
   * Spec §6; the Keycloak side explains how.
   */
  async mintSession(project: Project, userId: string, aal: AssuranceLevel = 'aal1'): Promise<MintedTokens> {
    const realm = project.keycloakRealm;
    const clientId = realmPublicClientId(realm, aal);
    const apiBase = this.sdkAuth.getPublicApiBase();
    await this.keycloak
      .ensureRealmClientGoTrueMappers(realm, clientId)
      .catch((err: any) => this.logger.warn(`GoTrue mappers not ensured on ${clientId}: ${err?.message ?? err}`));
    await this.keycloak.ensureAnonClientRedirectUri(realm, `${apiBase}/rest/v1/auth/callback/${project.id}/*`, clientId);
    return this.keycloak.mintSessionForUser(
      realm,
      userId,
      clientId,
      `${apiBase}/rest/v1/auth/callback/${project.id}/_mint`,
    );
  }

  /** The password grant, with the imported-hash adoption sign-in does. */
  private async passwordGrant(
    project: Project,
    email: string,
    password: string,
    clientIp: string | undefined,
    opts: { totp?: string; aal?: AssuranceLevel } = {},
  ): Promise<MintedTokens> {
    const realm = project.keycloakRealm;
    const clientId = realmPublicClientId(realm, opts.aal ?? 'aal1');
    const grant = () =>
      this.sdkAuth.authenticateInRealm(realm, clientId, email, password, false, clientIp, {
        projectId: project.id,
        totp: opts.totp,
      });
    try {
      return await grant();
    } catch (err) {
      if (
        !(err instanceof UnauthorizedException) ||
        !(await this.importedPasswords.adoptOnSignIn(project.id, realm, email, password))
      ) {
        throw err;
      }
      return grant();
    }
  }

  /** Which of the realm's clients a refresh token belongs to (its `azp`), so an aal2 session refreshes as aal2. */
  private clientOfRefreshToken(realm: string, refreshToken: string): string {
    const azp = decodeJwtPayload(refreshToken)?.azp;
    return typeof azp === 'string' && ProjectJwtVerifier.allowedClients(realm).includes(azp)
      ? azp
      : realmPublicClientId(realm);
  }

  // ── /token ──────────────────────────────────────────────────────────────

  async signInWithPassword(
    projectId: string,
    body: { email?: string; password?: string; totp?: string },
    clientIp?: string,
  ): Promise<GoTrueSession> {
    const email = (body.email ?? '').trim();
    if (!email || !body.password) {
      throw new GoTrueError(400, 'validation_failed', 'missing email or phone');
    }
    const project = await this.getProject(projectId);
    const cfg = await this.authConfig.getOrCreate(projectId);
    const realm = project.keycloakRealm;

    const tokens = await this.passwordGrant(project, email, body.password, clientIp, { totp: body.totp });
    const sub = decodeJwtPayload(tokens.accessToken)?.sub;
    const rep = typeof sub === 'string' ? await this.keycloak.getRealmUserRepresentation(realm, sub) : null;
    if (!rep?.id) throw new GoTrueError(500, 'unexpected_failure', 'Signed in, but the user could not be read');

    if (cfg.requireEmailVerify && !rep.emailVerified) {
      await this.sdkAuth.revokeRefreshToken(realm, realmPublicClientId(realm), tokens.refreshToken);
      throw new GoTrueError(400, 'email_not_confirmed', 'Email not confirmed');
    }

    void this.importedPasswords.settleForUser(projectId, rep.id).catch(() => undefined);

    // An enrolled authenticator: GoTrue hands out the aal1 session now and lets the app step
    // up through /factors. The aal2 tokens are minted while the password is still in hand and
    // parked under a challenge a correct code releases (spec §7.15).
    const mfaRow = await this.mfa.getState(projectId, rep.id).catch(() => null);
    if (mfaRow?.verifiedAt) {
      try {
        const aal2 = await this.passwordGrant(project, email, body.password, clientIp, { totp: body.totp, aal: 'aal2' });
        await this.parkAal2Tokens(project, rep.id, aal2, { emailVerified: !!rep.emailVerified, account: rep.email ?? email });
      } catch (err: any) {
        this.logger.warn(`aal2 tokens not parked for ${rep.id} on ${projectId}: ${err?.message ?? err}`);
      }
    }

    return this.sessionFromTokens(project, tokens);
  }

  private async parkAal2Tokens(
    project: Project,
    userId: string,
    tokens: MintedTokens,
    extra: { emailVerified: boolean; account: string },
  ): Promise<{ challengeId: string; expiresIn: number }> {
    const ch = await this.mfa.createChallenge(project.id, project.keycloakRealm, userId, tokens, 'verify', extra);
    await this.redis.set(this.pendingMfaKey(project.id, userId), ch.challengeId, ch.expiresIn);
    return { challengeId: ch.challengeId, expiresIn: ch.expiresIn };
  }

  async refresh(projectId: string, refreshToken: string | undefined): Promise<GoTrueSession> {
    if (!refreshToken) throw new GoTrueError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    const project = await this.getProject(projectId);
    const clientId = this.clientOfRefreshToken(project.keycloakRealm, refreshToken);
    const tokens = await this.sdkAuth.refresh(projectId, refreshToken, clientId);
    return this.sessionFromTokens(project, { ...tokens, tokenType: 'bearer' });
  }

  async exchangeCode(projectId: string, authCode: string | undefined, codeVerifier: string | undefined): Promise<GoTrueSession> {
    if (!authCode || !codeVerifier) throw new GoTrueError(400, 'validation_failed', 'invalid request: both auth code and code verifier should be non-empty');
    const project = await this.getProject(projectId);
    const raw = await this.redis.getdel(this.flowKey(projectId, authCode));
    if (!raw) throw new GoTrueError(404, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
    const flow = JSON.parse(raw) as StoredFlow;
    if (pkceChallenge(codeVerifier, flow.codeChallengeMethod) !== flow.codeChallenge) {
      throw new GoTrueError(400, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
    }
    const tokens = flow.tokens ?? (await this.mintSession(project, flow.userId, flow.aal ?? 'aal1'));
    return this.sessionFromTokens(project, tokens);
  }

  // ── /user, /logout ──────────────────────────────────────────────────────

  async getUser(projectId: string, accessToken: string): Promise<GoTrueUser> {
    const project = await this.getProject(projectId);
    // userinfo, not just the signature: a token whose session was ended must answer 401.
    const info = await this.sdkAuth.getUserFromToken(project, accessToken);
    return this.userById(project, info.id);
  }

  async updateUser(
    projectId: string,
    userId: string,
    body: { password?: string; email?: string; data?: Record<string, unknown>; phone?: string; nonce?: string },
    redirectTo?: string,
  ): Promise<GoTrueUser & { new_email?: string; email_change_sent_at?: string }> {
    const project = await this.getProject(projectId);
    const realm = project.keycloakRealm;
    let newEmail: string | undefined;

    if (body.password !== undefined) {
      const cfg = await this.authConfig.getOrCreate(projectId);
      if (typeof body.password !== 'string' || body.password.length < cfg.minPasswordLength) {
        throw new GoTrueError(422, 'weak_password', `Password should be at least ${cfg.minPasswordLength} characters.`, { reasons: ['length'] });
      }
      await this.keycloak.resetRealmUserPassword(realm, userId, body.password);
    }

    if (body.data && typeof body.data === 'object') {
      await this.keycloak.setRealmUserMetadata(realm, userId, { user_metadata: body.data });
    }

    if (body.phone !== undefined) {
      await this.keycloak.setRealmUserAttributes(realm, userId, { phoneNumber: body.phone ? [String(body.phone)] : [] });
    }

    if (body.email) {
      const current = await this.keycloak.getRealmUserRepresentation(realm, userId);
      const wanted = body.email.trim();
      if (current?.email?.toLowerCase() !== wanted.toLowerCase()) {
        const taken = await this.keycloak.findUserInRealm(realm, wanted);
        if (taken) throw new GoTrueError(422, 'email_exists', 'A user with this email address has already been registered');
        newEmail = wanted;
        const link = await this.issueLink(project, {
          type: 'email_change',
          userId,
          email: current?.email ?? wanted,
          redirectTo: await this.resolveRedirect(projectId, redirectTo),
          newEmail: wanted,
        });
        this.sendLinkMail(project, link, 'email_change', wanted, { new_email: wanted });
      }
    }

    const user = await this.userById(project, userId);
    return newEmail ? { ...user, new_email: newEmail, email_change_sent_at: new Date().toISOString() } : user;
  }

  async logout(projectId: string, claims: Record<string, unknown>, scope: string | undefined): Promise<void> {
    const project = await this.getProject(projectId);
    const realm = project.keycloakRealm;
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
    const sid = typeof claims.sid === 'string' ? claims.sid : undefined;
    if (!sub) return;
    try {
      if (scope === 'local' && sid) {
        await this.keycloak.revokeUserSession(realm, sid);
      } else if (scope === 'others') {
        const sessions = await this.keycloak.listUserSessions(realm, sub);
        for (const s of sessions) {
          if (s.id && s.id !== sid) await this.keycloak.revokeUserSession(realm, s.id).catch(() => undefined);
        }
      } else {
        await this.keycloak.logoutAllUserSessions(realm, sub);
      }
    } catch (err: any) {
      // The client forgets the session either way; a failure here only leaves a Keycloak
      // session that expires on its own.
      this.logger.warn(`Logout (${scope ?? 'global'}) for ${sub} on ${projectId} failed: ${err?.message ?? err}`);
    }
  }

  // ── /signup, /recover, /otp, /resend ────────────────────────────────────

  async signup(
    projectId: string,
    body: {
      email?: string;
      password?: string;
      data?: Record<string, unknown>;
      code_challenge?: string;
      code_challenge_method?: string;
    },
    clientIp: string | undefined,
    redirectTo: string | undefined,
  ): Promise<GoTrueSession | (GoTrueUser & { confirmation_sent_at: string })> {
    const email = (body.email ?? '').trim();
    if (!email) throw new GoTrueError(400, 'validation_failed', 'Signup requires a valid email');
    if (typeof body.password !== 'string' || !body.password) {
      throw new GoTrueError(400, 'validation_failed', 'Signup requires a valid password');
    }
    const project = await this.getProject(projectId);
    const cfg = await this.authConfig.getOrCreate(projectId);
    const realm = project.keycloakRealm;

    if (!cfg.allowSignup) throw new ForbiddenException('Self-signup is disabled for this project');
    if (await this.keycloak.findUserInRealm(realm, email)) throw new ConflictException('Email already registered');
    if (body.password.length < cfg.minPasswordLength) {
      throw new GoTrueError(422, 'weak_password', `Password should be at least ${cfg.minPasswordLength} characters.`, { reasons: ['length'] });
    }

    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const userId = await this.keycloak.createProjectUser(
      realm,
      { email, password: body.password, ...namesFromMetadata(data) },
      !cfg.requireEmailVerify,
      { user_metadata: data },
    );

    if (cfg.requireEmailVerify) {
      const link = await this.issueLink(project, {
        type: 'signup',
        userId,
        email,
        redirectTo: await this.resolveRedirect(projectId, redirectTo),
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method === 'plain' ? 'plain' : 's256',
      });
      this.sendLinkMail(project, link, 'signup', email, {});
      const user = await this.userById(project, userId);
      return { ...user, confirmation_sent_at: new Date().toISOString() };
    }

    const tokens = await this.passwordGrant(project, email, body.password, clientIp);
    return this.sessionFromTokens(project, tokens);
  }

  async recover(projectId: string, body: { email?: string; code_challenge?: string; code_challenge_method?: string }, redirectTo?: string): Promise<void> {
    const email = (body.email ?? '').trim();
    if (!email) throw new GoTrueError(400, 'validation_failed', 'Password recovery requires an email');
    const project = await this.getProject(projectId);
    const user = await this.keycloak.findUserInRealm(project.keycloakRealm, email);
    // An unknown address, or an anonymous identity's placeholder, is answered like a known one.
    if (!user?.id || this.keycloak.isAnonymousUser(user)) return;
    const link = await this.issueLink(project, {
      type: 'recovery',
      userId: user.id,
      email: user.email ?? email,
      redirectTo: await this.resolveRedirect(projectId, redirectTo),
      codeChallenge: body.code_challenge,
      codeChallengeMethod: body.code_challenge_method === 'plain' ? 'plain' : 's256',
    });
    this.sendLinkMail(project, link, 'recovery', user.email ?? email, {});
  }

  async sendOtp(
    projectId: string,
    body: { email?: string; create_user?: boolean; data?: Record<string, unknown>; code_challenge?: string; code_challenge_method?: string },
    redirectTo?: string,
  ): Promise<void> {
    const email = (body.email ?? '').trim();
    if (!email) throw new GoTrueError(400, 'validation_failed', 'You must provide either an email or phone number');
    const project = await this.getProject(projectId);
    const realm = project.keycloakRealm;
    const found = await this.keycloak.findUserInRealm(realm, email);
    const user = found?.id && !this.keycloak.isAnonymousUser(found) ? found : null;
    let userId = user?.id;
    if (!userId) {
      if (body.create_user === false) throw new GoTrueError(422, 'otp_disabled', 'Signups not allowed for otp');
      const cfg = await this.authConfig.getOrCreate(projectId);
      if (!cfg.allowSignup) throw new GoTrueError(422, 'signup_disabled', 'Signups not allowed for this instance');
      const data = body.data && typeof body.data === 'object' ? body.data : {};
      userId = await this.keycloak.createProjectUser(realm, { email, ...namesFromMetadata(data) }, false, { user_metadata: data });
    }
    const link = await this.issueLink(project, {
      type: 'magiclink',
      userId,
      email: user?.email ?? email,
      redirectTo: await this.resolveRedirect(projectId, redirectTo),
      codeChallenge: body.code_challenge,
      codeChallengeMethod: body.code_challenge_method === 'plain' ? 'plain' : 's256',
    });
    this.sendLinkMail(project, link, 'magiclink', user?.email ?? email, {});
  }

  async resend(projectId: string, body: { type?: string; email?: string }, redirectTo?: string): Promise<void> {
    const email = (body.email ?? '').trim();
    if (!email) throw new GoTrueError(400, 'validation_failed', 'Resend requires an email');
    const project = await this.getProject(projectId);
    const realm = project.keycloakRealm;
    if (body.type === 'signup') {
      const user = await this.keycloak.findUserInRealm(realm, email);
      if (!user?.id || user.emailVerified) return;
      const link = await this.issueLink(project, { type: 'signup', userId: user.id, email, redirectTo: await this.resolveRedirect(projectId, redirectTo) });
      this.sendLinkMail(project, link, 'signup', email, {});
      return;
    }
    if (body.type === 'email_change') {
      const pointer = await this.redis.get(this.eotpKey(projectId, 'email_change', email));
      if (!pointer) return;
      const { tokenKey } = JSON.parse(pointer) as { tokenKey: string };
      const stored = await this.redis.get(tokenKey);
      if (!stored) return;
      const link = JSON.parse(stored) as StoredLink;
      if (!link.newEmail) return;
      // The stored token stays valid; only the mail goes out again.
      const fresh = await this.issueLink(project, {
        type: 'email_change', userId: link.userId, email, redirectTo: link.redirectTo, newEmail: link.newEmail,
      });
      this.sendLinkMail(project, fresh, 'email_change', link.newEmail, { new_email: link.newEmail });
    }
  }

  // ── One-time links (spec §8) ────────────────────────────────────────────

  async issueLink(
    project: Project,
    input: {
      type: GoTrueLinkType;
      userId: string;
      email: string;
      redirectTo: string;
      codeChallenge?: string;
      codeChallengeMethod?: 's256' | 'plain';
      newEmail?: string;
    },
  ): Promise<IssuedLink> {
    const raw = randomBytes(32).toString('hex');
    const otp = String(randomInt(100000, 999999));
    const eotpKey = this.eotpKey(project.id, input.type, input.email);
    const tokenKey = this.tokKey(project.id, raw);
    const ttl = LINK_TTL[input.type];
    const entry: StoredLink = {
      type: input.type,
      userId: input.userId,
      email: input.email,
      redirectTo: input.redirectTo,
      codeChallenge: input.codeChallenge || undefined,
      codeChallengeMethod: input.codeChallenge ? (input.codeChallengeMethod ?? 's256') : undefined,
      newEmail: input.newEmail,
      otp,
      eotpKey,
      createdAt: Date.now(),
    };
    await this.redis.set(tokenKey, JSON.stringify(entry), ttl);
    await this.redis.set(eotpKey, JSON.stringify({ otp, tokenKey }), ttl);
    const apiBase = this.sdkAuth.getPublicApiBase();
    const params = new URLSearchParams({
      token: raw,
      type: input.type,
      redirect_to: input.redirectTo,
      apikey: project.anonKey,
    });
    return {
      hashed_token: raw,
      email_otp: otp,
      action_link: `${apiBase}/auth/v1/verify?${params.toString()}`,
      redirect_to: input.redirectTo,
      verification_type: input.type,
    };
  }

  /** Mail for a link, best-effort: a mail that fails to leave is logged, never an error to the caller. */
  sendLinkMail(project: Project, link: IssuedLink, type: GoTrueLinkType, to: string, extra: Record<string, string>): void {
    const urlVar: Record<GoTrueLinkType, string> = {
      signup: 'verify_url',
      magiclink: 'magic_link_url',
      recovery: 'confirm_url',
      invite: 'invite_url',
      email_change: 'confirm_url',
    };
    const vars: Record<string, string> = {
      otp: link.email_otp,
      token_hash: link.hashed_token,
      redirect_to: link.redirect_to,
      site_url: link.redirect_to,
      [urlVar[type]]: link.action_link,
      default_html: this.defaultMailBody(type, project.name),
      ...extra,
    };
    this.sdkAuth
      .sendProjectEmail(project.id, to, project.name, LINK_MAIL[type], vars)
      .catch((err: any) => this.logger.warn(`${type} mail to ${to} on ${project.id} failed: ${err?.message ?? err}`));
  }

  /** The body used when the project has no template for the mail: the link, and the code for apps that ask for one. */
  private defaultMailBody(type: GoTrueLinkType, projectName: string): string {
    const title: Record<GoTrueLinkType, [string, string]> = {
      signup: ['Confirm your email', 'Confirm your email address to finish signing up.'],
      magiclink: ['Sign in', 'Use the link below to sign in.'],
      recovery: ['Reset your password', 'Use the link below to choose a new password.'],
      invite: ['You have been invited', `You have been invited to ${projectName}. Accept the invitation to set up your account.`],
      email_change: ['Confirm your new email', 'Confirm that this is your new email address.'],
    };
    const [heading, lead] = title[type];
    return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
<div style="max-width:480px;margin:32px auto;padding:32px;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
<h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${heading}</h1>
<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">${lead}</p>
<p style="margin:0 0 24px;"><a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 20px;background:#0d9488;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;">Continue</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#64748b;">If the button does not work, enter this code where asked:</p>
<p style="margin:0 0 24px;font-size:22px;letter-spacing:4px;font-weight:700;color:#0f172a;">{{ .Token }}</p>
<p style="margin:0;font-size:12px;color:#94a3b8;">Sent by {{project_name}}. If you did not request this, you can ignore this email.</p>
</div></body></html>`;
  }

  /** A link redeemed by the token it carries; gone once read (atomic getdel). */
  private async redeemByHash(project: Project, rawToken: string | undefined, requestedType: string | undefined): Promise<StoredLink> {
    if (!rawToken || !requestedType) throw new GoTrueError(400, 'validation_failed', 'Verify requires a token and a type');
    const stored = await this.redis.getdel(this.tokKey(project.id, rawToken));
    if (!stored) throw new GoTrueError(403, 'otp_expired', 'Email link is invalid or has expired');
    const link = JSON.parse(stored) as StoredLink;
    await this.redis.del(link.eotpKey).catch(() => undefined);
    if (!linkTypeMatches(requestedType, link.type)) {
      throw new GoTrueError(403, 'otp_expired', 'Email link is invalid or has expired');
    }
    return link;
  }

  /** A link redeemed by the six-digit code mailed with it, with a per-address attempt limit. */
  private async redeemByEmailOtp(project: Project, requestedType: string | undefined, email: string | undefined, otp: string | undefined): Promise<StoredLink> {
    if (!requestedType || !email || !otp) throw new GoTrueError(400, 'validation_failed', 'Verify requires a type, an email and a token');
    const storedTypes: GoTrueLinkType[] = (['signup', 'magiclink', 'recovery', 'invite', 'email_change'] as GoTrueLinkType[]).filter((t) =>
      linkTypeMatches(requestedType, t),
    );
    const attemptsKey = this.eotpAttemptsKey(project.id, requestedType, email);
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) await this.redis.expire(attemptsKey, OTP_ATTEMPT_WINDOW_SECONDS);
    if (attempts > OTP_ATTEMPT_LIMIT) {
      throw new GoTrueError(429, 'over_request_rate_limit', 'Too many attempts, request a new code');
    }
    for (const type of storedTypes) {
      const pointer = await this.redis.get(this.eotpKey(project.id, type, email));
      if (!pointer) continue;
      const { otp: expected, tokenKey } = JSON.parse(pointer) as { otp: string; tokenKey: string };
      if (expected !== String(otp).trim()) continue;
      const stored = await this.redis.getdel(tokenKey);
      if (!stored) continue;
      await this.redis.del(this.eotpKey(project.id, type, email)).catch(() => undefined);
      await this.redis.del(attemptsKey).catch(() => undefined);
      return JSON.parse(stored) as StoredLink;
    }
    throw new GoTrueError(403, 'otp_expired', 'Token has expired or is invalid');
  }

  /** What redeeming a link proves, applied to the realm. */
  private async applyLink(project: Project, link: StoredLink): Promise<void> {
    const realm = project.keycloakRealm;
    switch (link.type) {
      case 'signup':
      case 'magiclink':
      case 'invite': {
        const rep = await this.keycloak.getRealmUserRepresentation(realm, link.userId);
        if (!rep?.id) throw new GoTrueError(404, 'user_not_found', 'User not found');
        if (!rep.emailVerified) {
          await this.keycloak.setEmailVerified(realm, link.userId);
          if (link.type === 'signup' && rep.email) {
            this.sdkAuth
              .sendProjectEmail(project.id, rep.email, project.name, 'welcome', {})
              .catch((err: any) => this.logger.warn(`Welcome mail failed: ${err?.message ?? err}`));
          }
        }
        return;
      }
      case 'email_change':
        if (link.newEmail) await this.keycloak.updateRealmUserEmail(realm, link.userId, link.newEmail);
        return;
      case 'recovery':
        return;
    }
  }

  /** `POST /verify`: a session for the user the link names. */
  async verify(
    projectId: string,
    body: { type?: string; token_hash?: string; token?: string; email?: string },
  ): Promise<GoTrueSession> {
    const project = await this.getProject(projectId);
    const link = body.token_hash
      ? await this.redeemByHash(project, body.token_hash, body.type)
      : await this.redeemByEmailOtp(project, body.type, body.email, body.token);
    await this.applyLink(project, link);
    const tokens = await this.mintSession(project, link.userId);
    return this.sessionFromTokens(project, tokens);
  }

  /**
   * `GET /verify`: the mailed link itself. Always answers with a redirect — the tokens in
   * the fragment, a PKCE code in the query, or the error in the fragment — because a
   * browser opened it and has nowhere else to show anything.
   */
  async verifyRedirect(
    projectId: string,
    query: { token?: string; type?: string; redirect_to?: string },
  ): Promise<string> {
    const project = await this.getProject(projectId);
    let target = await this.resolveRedirect(projectId, query.redirect_to);
    try {
      const link = await this.redeemByHash(project, query.token, query.type);
      target = await this.resolveRedirect(projectId, query.redirect_to || link.redirectTo);
      await this.applyLink(project, link);
      if (link.codeChallenge) {
        const code = randomBytes(24).toString('base64url');
        const flow: StoredFlow = {
          userId: link.userId,
          codeChallenge: link.codeChallenge,
          codeChallengeMethod: link.codeChallengeMethod ?? 's256',
          type: link.type,
        };
        await this.redis.set(this.flowKey(projectId, code), JSON.stringify(flow), FLOW_TTL_SECONDS);
        return withQuery(target, { code, type: link.type });
      }
      const tokens = await this.mintSession(project, link.userId);
      const session = await this.sessionFromTokens(project, tokens);
      return withFragment(target, {
        access_token: session.access_token,
        expires_at: String(session.expires_at ?? ''),
        expires_in: String(session.expires_in),
        refresh_token: session.refresh_token,
        token_type: 'bearer',
        type: link.type,
      });
    } catch (err: any) {
      const code = err instanceof GoTrueError ? err.code : 'unexpected_failure';
      const description = err instanceof GoTrueError ? (err.getResponse() as any).message : 'Verification failed';
      this.logger.warn(`Link verification failed on ${projectId}: ${code} ${err?.message ?? err}`);
      return withFragment(target, { error: 'access_denied', error_code: code, error_description: description });
    }
  }

  /** ProjectAuthConfig.redirectUrls — the app URLs this project registered. */
  private async allowedRedirectUrls(projectId: string): Promise<string[]> {
    const config = (await this.authConfig.getRaw(projectId)) as { redirectUrls?: unknown };
    return Array.isArray(config?.redirectUrls)
      ? config.redirectUrls.filter((url): url is string => typeof url === 'string')
      : [];
  }

  /**
   * Where a link may send the browser: the requested URL when the project registered it,
   * else the first registered URL, else the API root. Never an unregistered host — the
   * tokens ride in the fragment of whatever is chosen here.
   */
  async resolveRedirect(projectId: string, requested: string | undefined): Promise<string> {
    const allowed = await this.allowedRedirectUrls(projectId);
    const direct = requested ? resolveOAuthRedirect(requested, allowed) : null;
    if (direct && direct !== '/') return direct;
    if (direct === '/' && !allowed.length) return '/';
    return resolveOAuthRedirect(allowed[0], allowed) ?? direct ?? '/';
  }

  // ── /settings ───────────────────────────────────────────────────────────

  async settings(projectId: string) {
    const cfg = await this.authConfig.getOrCreate(projectId);
    return {
      external: {
        email: true,
        phone: false,
        anonymous_users: !!cfg.allowAnonymous,
        google: !!cfg.googleEnabled,
        github: !!cfg.githubEnabled,
        azure: !!cfg.microsoftEnabled,
        apple: !!cfg.appleEnabled,
        gitlab: !!cfg.gitlabEnabled,
        linkedin_oidc: !!cfg.linkedinEnabled,
        facebook: !!cfg.facebookEnabled,
        twitter: !!cfg.twitterEnabled,
      },
      disable_signup: !cfg.allowSignup,
      mailer_autoconfirm: !cfg.requireEmailVerify,
      phone_autoconfirm: false,
      sms_provider: '',
      saml_enabled: false,
      external_labels: {},
    };
  }

  // ── OAuth (spec §7 /authorize, callback) ────────────────────────────────

  /** The Keycloak authorization URL `GET /authorize` sends the browser to. */
  async authorizeUrl(
    projectId: string,
    query: { provider?: string; redirect_to?: string; code_challenge?: string; code_challenge_method?: string },
  ): Promise<string> {
    const provider = mapProviderName((query.provider ?? '').trim());
    if (!provider) throw new GoTrueError(400, 'validation_failed', 'Unsupported provider: missing provider');
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new GoTrueError(400, 'validation_failed', `Unsupported provider: provider is not enabled`);
    }
    const extras: OAuthStateExtras = { gotrue: true };
    if (query.code_challenge) {
      extras.codeChallenge = query.code_challenge;
      extras.codeChallengeMethod = query.code_challenge_method === 'plain' ? 'plain' : 's256';
    }
    const { url } = await this.sdkAuth.getOAuthRedirectUrl(projectId, provider, query.redirect_to, {
      extras,
      fallbackRedirect: true,
    });
    return url;
  }

  /**
   * After the provider round trip: record the provider on the user, refresh so the token
   * carries it, and answer the way the app's supabase-js expects — a PKCE code, or the
   * session in the fragment.
   */
  async completeOAuth(
    projectId: string,
    provider: string,
    result: MintedTokens & { redirectTo: string } & OAuthStateExtras,
  ): Promise<string> {
    const project = await this.getProject(projectId);
    const alias = mapProviderName(provider);
    const sub = decodeJwtPayload(result.accessToken)?.sub;
    let tokens: MintedTokens = result;
    if (typeof sub === 'string' && sub) {
      try {
        const rep = await this.keycloak.getRealmUserRepresentation(project.keycloakRealm, sub);
        const app = readJsonAttribute(rep as any, 'app_metadata');
        const providers = Array.isArray(app.providers) ? (app.providers as unknown[]).filter((p): p is string => typeof p === 'string') : ['email'];
        if (!providers.includes(alias)) {
          await this.keycloak.setRealmUserMetadata(project.keycloakRealm, sub, {
            app_metadata: { provider: typeof app.provider === 'string' && app.provider ? app.provider : alias, providers: [...providers, alias] },
          });
          // Once, so the token the app receives already says so.
          const refreshed = await this.sdkAuth.refresh(projectId, result.refreshToken, this.clientOfRefreshToken(project.keycloakRealm, result.refreshToken));
          tokens = { ...refreshed, tokenType: 'bearer' };
        }
      } catch (err: any) {
        this.logger.warn(`Provider "${alias}" not recorded on ${sub}: ${err?.message ?? err}`);
      }
      this.touchLastSignIn(project, sub);
    }
    if (result.codeChallenge) {
      const code = randomBytes(24).toString('base64url');
      const flow: StoredFlow = {
        userId: typeof sub === 'string' ? sub : '',
        tokens,
        codeChallenge: result.codeChallenge,
        codeChallengeMethod: result.codeChallengeMethod ?? 's256',
        type: 'oauth',
      };
      await this.redis.set(this.flowKey(projectId, code), JSON.stringify(flow), FLOW_TTL_SECONDS);
      return withQuery(result.redirectTo, { code });
    }
    const exp = decodeJwtPayload(tokens.accessToken)?.exp;
    return withFragment(result.redirectTo, {
      access_token: tokens.accessToken,
      expires_at: String(typeof exp === 'number' ? exp : Math.floor(Date.now() / 1000) + Number(tokens.expiresIn || 0)),
      expires_in: String(tokens.expiresIn),
      refresh_token: tokens.refreshToken,
      token_type: 'bearer',
      provider_token: '',
      provider: alias,
    });
  }

  // ── Admin (spec §7) ─────────────────────────────────────────────────────

  async listUsers(projectId: string, page: number, perPage: number) {
    const project = await this.getProject(projectId);
    const { users, total } = await this.keycloak.listRealmUsersPage(project.keycloakRealm, (page - 1) * perPage, perPage);
    const enrolled = await this.mfa.listEnrolled(projectId).catch(() => []);
    const factorByUser = new Map(enrolled.map((e) => [e.keycloakUserId, e]));
    return {
      total,
      users: users.map((rep) => {
        const f = factorByUser.get(rep.id ?? '');
        const factors: GoTrueFactor[] = f
          ? [{
              id: rep.id ?? '',
              factor_type: 'totp',
              friendly_name: 'Authenticator app',
              status: 'verified',
              created_at: new Date(f.verifiedAt ?? Date.now()).toISOString(),
              updated_at: new Date(f.lastUsedAt ?? f.verifiedAt ?? Date.now()).toISOString(),
            }]
          : [];
        return buildUser(rep as any, { factors });
      }),
    };
  }

  async adminCreateUser(
    projectId: string,
    body: {
      email?: string;
      password?: string;
      email_confirm?: boolean;
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
      phone?: string;
      ban_duration?: string;
    },
  ): Promise<GoTrueUser> {
    const email = (body.email ?? '').trim();
    if (!email) throw new GoTrueError(400, 'validation_failed', 'Cannot create a user without either an email or phone');
    const project = await this.getProject(projectId);
    const realm = project.keycloakRealm;
    if (await this.keycloak.findUserInRealm(realm, email)) {
      throw new ConflictException('User already exists in this project');
    }
    const userId = await this.keycloak.createProjectUser(
      realm,
      { email, password: body.password || undefined, ...namesFromMetadata(body.user_metadata) },
      !!body.email_confirm,
      { user_metadata: body.user_metadata, app_metadata: body.app_metadata, phone: body.phone },
    );
    if (body.ban_duration) await this.applyBan(realm, userId, body.ban_duration);
    return this.userById(project, userId);
  }

  async adminGetUser(projectId: string, userId: string): Promise<GoTrueUser> {
    return this.userById(await this.getProject(projectId), userId);
  }

  async adminUpdateUser(
    projectId: string,
    userId: string,
    body: {
      email?: string;
      password?: string;
      email_confirm?: boolean;
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
      phone?: string;
      ban_duration?: string;
    },
  ): Promise<GoTrueUser> {
    const project = await this.getProject(projectId);
    const realm = project.keycloakRealm;
    const current = await this.keycloak.getRealmUserRepresentation(realm, userId);
    if (!current?.id) throw new GoTrueError(404, 'user_not_found', 'User not found');

    const update: Parameters<KeycloakAdminService['updateRealmUser']>[2] = {};
    if (body.email && body.email.trim().toLowerCase() !== (current.email ?? '').toLowerCase()) {
      update.email = body.email.trim();
      update.emailVerified = body.email_confirm ?? true;
    } else if (body.email_confirm !== undefined) {
      update.emailVerified = !!body.email_confirm;
    }
    if (body.phone !== undefined) update.phoneNumber = body.phone ? String(body.phone) : '';
    if (Object.keys(update).length) await this.keycloak.updateRealmUser(realm, userId, update);

    if (body.password) await this.keycloak.resetRealmUserPassword(realm, userId, body.password);
    if (body.user_metadata || body.app_metadata) {
      await this.keycloak.setRealmUserMetadata(realm, userId, {
        user_metadata: body.user_metadata,
        app_metadata: body.app_metadata,
      });
    }
    if (body.ban_duration) await this.applyBan(realm, userId, body.ban_duration);
    return this.userById(project, userId);
  }

  async adminDeleteUser(projectId: string, userId: string): Promise<void> {
    const project = await this.getProject(projectId);
    const rep = await this.keycloak.getRealmUserRepresentation(project.keycloakRealm, userId);
    if (!rep?.id) throw new GoTrueError(404, 'user_not_found', 'User not found');
    await this.keycloak.deleteUser(project.keycloakRealm, userId);
    await this.mfa.forgetUser(projectId, userId).catch(() => undefined);
  }

  /**
   * GoTrue's `ban_duration` is a Go duration (`24h`, `30m`, `1h30m`, `876600h`) or `none`.
   * A banned user is disabled in the realm and carries `banned_until`; `none` lifts it.
   */
  private async applyBan(realm: string, userId: string, duration: string): Promise<void> {
    if (duration === 'none') {
      await this.keycloak.updateRealmUser(realm, userId, { enabled: true });
      await this.keycloak.setRealmUserAttributes(realm, userId, { banned_until: [] });
      return;
    }
    const ms = parseGoDuration(duration);
    if (ms === null) throw new GoTrueError(400, 'validation_failed', 'invalid format for ban duration');
    await this.keycloak.updateRealmUser(realm, userId, { enabled: false });
    await this.keycloak.setRealmUserAttributes(realm, userId, { banned_until: [new Date(Date.now() + ms).toISOString()] });
  }

  async generateLink(
    projectId: string,
    body: { type?: string; email?: string; password?: string; new_email?: string; data?: Record<string, unknown> },
    redirectTo?: string,
  ): Promise<GoTrueUser & IssuedLink> {
    const email = (body.email ?? '').trim();
    const type = body.type ?? '';
    if (!email) throw new GoTrueError(400, 'validation_failed', 'generate_link requires an email');
    const project = await this.getProject(projectId);
    const realm = project.keycloakRealm;
    const data = body.data && typeof body.data === 'object' ? body.data : undefined;
    const existing = await this.keycloak.findUserInRealm(realm, email);
    let userId = existing?.id;
    let linkType: GoTrueLinkType;
    let newEmail: string | undefined;

    switch (type) {
      case 'signup':
        if (userId) throw new ConflictException('User already exists in this project');
        if (!body.password) throw new GoTrueError(400, 'validation_failed', 'signup requires a password');
        userId = await this.keycloak.createProjectUser(realm, { email, password: body.password, ...namesFromMetadata(data) }, false, { user_metadata: data });
        linkType = 'signup';
        break;
      case 'invite':
        if (!userId) {
          userId = await this.keycloak.createProjectUser(realm, { email, ...namesFromMetadata(data) }, false, { user_metadata: data });
          await this.keycloak.setRealmUserAttributes(realm, userId, { invited_at: [new Date().toISOString()] }).catch(() => undefined);
        }
        linkType = 'invite';
        break;
      case 'magiclink':
        if (!userId) userId = await this.keycloak.createProjectUser(realm, { email, ...namesFromMetadata(data) }, false, { user_metadata: data });
        linkType = 'magiclink';
        break;
      case 'recovery':
        if (!userId) throw new NotFoundException('User not found');
        linkType = 'recovery';
        break;
      case 'email_change_current':
      case 'email_change_new':
        if (!userId) throw new NotFoundException('User not found');
        if (!body.new_email) throw new GoTrueError(400, 'validation_failed', 'email change requires a new_email');
        newEmail = body.new_email.trim();
        linkType = 'email_change';
        break;
      default:
        throw new GoTrueError(400, 'validation_failed', 'invalid type: must be one of signup, magiclink, invite, recovery, email_change_current, email_change_new');
    }

    const link = await this.issueLink(project, {
      type: linkType,
      userId: userId!,
      email,
      redirectTo: await this.resolveRedirect(projectId, redirectTo),
      newEmail,
    });
    const user = await this.userById(project, userId!);
    return { ...user, ...link };
  }

  async invite(projectId: string, body: { email?: string; data?: Record<string, unknown> }, redirectTo?: string): Promise<GoTrueUser> {
    const email = (body.email ?? '').trim();
    if (!email) throw new GoTrueError(400, 'validation_failed', 'Invite requires an email');
    const project = await this.getProject(projectId);
    const realm = project.keycloakRealm;
    if (await this.keycloak.findUserInRealm(realm, email)) {
      throw new ConflictException('User already exists in this project');
    }
    const data = body.data && typeof body.data === 'object' ? body.data : undefined;
    const userId = await this.keycloak.createProjectUser(realm, { email, ...namesFromMetadata(data) }, false, { user_metadata: data });
    await this.keycloak.setRealmUserAttributes(realm, userId, { invited_at: [new Date().toISOString()] }).catch(() => undefined);
    const link = await this.issueLink(project, { type: 'invite', userId, email, redirectTo: await this.resolveRedirect(projectId, redirectTo) });
    this.sendLinkMail(project, link, 'invite', email, {});
    return this.userById(project, userId);
  }

  // ── MFA (spec §7.15) ────────────────────────────────────────────────────

  async enrollFactor(
    projectId: string,
    user: { userId: string; email?: string },
    body: { factor_type?: string; friendly_name?: string; issuer?: string },
  ) {
    if (body.factor_type !== 'totp') {
      throw new GoTrueError(422, 'validation_failed', 'factor_type needs to be totp');
    }
    const enrollment = await this.sdkAuth.beginMfaEnrollment(projectId, { userId: user.userId, email: user.email });
    const row = await this.mfa.getState(projectId, user.userId);
    const qr = await QRCode.toString(enrollment.otpauthUrl, { type: 'svg', margin: 1 });
    return {
      id: row?.id ?? user.userId,
      type: 'totp' as const,
      friendly_name: body.friendly_name ?? '',
      totp: { qr_code: qr, secret: enrollment.secret, uri: enrollment.otpauthUrl },
    };
  }

  /**
   * A challenge for the factor. For a verified factor it names the parked aal2 tokens —
   * minted at sign-in, or here when those have expired; for one still being enrolled it is
   * a handle the verify step accepts the first code with.
   */
  async challengeFactor(projectId: string, user: { userId: string; email?: string }, factorId: string) {
    const project = await this.getProject(projectId);
    const row = await this.mfa.getState(projectId, user.userId);
    if (!row || row.id !== factorId) throw new GoTrueError(404, 'mfa_factor_not_found', 'MFA factor not found');
    const ttl = this.mfa.challengeTtlSeconds;

    if (!row.verifiedAt) {
      const id = randomBytes(24).toString('base64url');
      await this.redis.set(this.enrollChallengeKey(projectId, id), user.userId, ENROLL_CHALLENGE_TTL_SECONDS);
      return { id, type: 'totp' as const, expires_at: Math.floor(Date.now() / 1000) + ENROLL_CHALLENGE_TTL_SECONDS };
    }

    const pending = await this.redis.get(this.pendingMfaKey(projectId, user.userId));
    if (pending) {
      const stored = await this.mfa.peekChallenge(projectId, pending).catch(() => null);
      if (stored && stored.kind === 'verify') {
        const left = Math.max(1, ttl - Math.floor((Date.now() - stored.createdAt) / 1000));
        return { id: pending, type: 'totp' as const, expires_at: Math.floor(Date.now() / 1000) + left };
      }
    }
    const rep = await this.keycloak.getRealmUserRepresentation(project.keycloakRealm, user.userId);
    const tokens = await this.mintSession(project, user.userId, 'aal2');
    const parked = await this.parkAal2Tokens(project, user.userId, tokens, {
      emailVerified: !!rep?.emailVerified,
      account: rep?.email ?? user.email ?? user.userId,
    });
    return { id: parked.challengeId, type: 'totp' as const, expires_at: Math.floor(Date.now() / 1000) + parked.expiresIn };
  }

  /** The code: releases the parked aal2 session, or confirms the enrollment and mints one. */
  async verifyFactor(
    projectId: string,
    user: { userId: string; email?: string },
    factorId: string,
    body: { challenge_id?: string; code?: string },
  ): Promise<GoTrueSession> {
    const project = await this.getProject(projectId);
    const row = await this.mfa.getState(projectId, user.userId);
    if (!row || row.id !== factorId) throw new GoTrueError(404, 'mfa_factor_not_found', 'MFA factor not found');
    if (!body.challenge_id || !body.code) throw new GoTrueError(400, 'validation_failed', 'challenge_id and code are required');

    if (row.verifiedAt) {
      const released = await this.sdkAuth.completeMfaChallenge(projectId, body.challenge_id, { code: body.code });
      if (released.userId !== user.userId) throw new GoTrueError(403, 'mfa_verification_failed', 'Challenge does not belong to this user');
      await this.redis.del(this.pendingMfaKey(projectId, user.userId)).catch(() => undefined);
      return this.sessionFromTokens(project, released);
    }

    const owner = await this.redis.getdel(this.enrollChallengeKey(projectId, body.challenge_id));
    if (owner !== user.userId) {
      throw new GoTrueError(422, 'mfa_challenge_expired', 'MFA challenge has expired, verify against another challenge or create a new challenge.');
    }
    await this.mfa.confirmEnrollment(projectId, user.userId, body.code);
    const tokens = await this.mintSession(project, user.userId, 'aal2');
    return this.sessionFromTokens(project, tokens);
  }

  /** Removing a verified factor needs an aal2 session; one still being enrolled can go at aal1. */
  async unenrollFactor(projectId: string, claims: Record<string, unknown>, factorId: string): Promise<{ id: string }> {
    const userId = String(claims.sub ?? '');
    const row = await this.mfa.getState(projectId, userId);
    if (!row || row.id !== factorId) throw new GoTrueError(404, 'mfa_factor_not_found', 'MFA factor not found');
    if (row.verifiedAt && claims.aal !== 'aal2') {
      throw new GoTrueError(403, 'insufficient_aal', 'AAL2 required to unenroll a verified factor');
    }
    await this.mfa.disable(projectId, userId, { force: true });
    await this.redis.del(this.pendingMfaKey(projectId, userId)).catch(() => undefined);
    return { id: factorId };
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  async jwks(projectId: string) {
    const project = await this.getProject(projectId);
    return this.verifier.getJwks(project.keycloakRealm);
  }

  /** A user token from the Authorization header that the guard did not look at (service-key calls). */
  async userFromBearer(projectId: string, authorization: string | undefined): Promise<Record<string, unknown> | null> {
    const token = authorization?.replace(/^bearer /i, '').trim();
    if (!token || token.split('.').length !== 3) return null;
    const project = await this.getProject(projectId);
    return this.verifier.verify(token, project.keycloakRealm);
  }
}

/** `target?k=v`, respecting a query the target already has. */
export function withQuery(target: string, params: Record<string, string>): string {
  const [base, hash] = target.split('#');
  const qs = new URLSearchParams(params).toString();
  const joined = base.includes('?') ? `${base}&${qs}` : `${base}?${qs}`;
  return hash ? `${joined}#${hash}` : joined;
}

/** `target#k=v`, replacing any fragment the target has (there must be exactly one). */
export function withFragment(target: string, params: Record<string, string>): string {
  const base = target.split('#')[0];
  return `${base}#${new URLSearchParams(params).toString()}`;
}

/** Milliseconds in a Go duration string (`1h30m`, `24h`, `876600h`, `30m`, `45s`), or null. */
export function parseGoDuration(value: string): number | null {
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  const units: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  let consumed = '';
  for (let m = re.exec(value); m; m = re.exec(value)) {
    total += parseFloat(m[1]) * units[m[2]];
    consumed += m[0];
  }
  return consumed === value && total > 0 ? Math.round(total) : null;
}
