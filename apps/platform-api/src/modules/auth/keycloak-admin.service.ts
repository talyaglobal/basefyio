import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import KcAdminClient from '@keycloak/keycloak-admin-client';
import { v4 as uuid } from 'uuid';
import { randomBytes } from 'crypto';
import axios from 'axios';
import { realmSmtpServer } from '../email/smtp-options';

export interface ProjectClients {
  anonKey: string;
  serviceKey: string;
}

/** The part of a Keycloak user an import writes. `id` is kept as given. */
export interface ImportedRealmUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  emailVerified: boolean;
  createdTimestamp?: number;
  /** Custom attributes, each a list of strings (`app_metadata` / `user_metadata` carry one JSON document). */
  attributes?: Record<string, string[]>;
}

export interface ImportedRealmUserResult {
  action: 'ADDED' | 'SKIPPED';
  username: string;
  /** The id the user has in the realm now: the given one when added, the existing user's when skipped. */
  id: string;
}

type SupportedIdpProvider =
  | 'google'
  | 'microsoft'
  | 'apple'
  | 'github'
  | 'gitlab'
  | 'linkedin'
  | 'facebook'
  | 'twitter';

/**
 * Puts the login time Keycloak keeps on every user session into the access token as
 * `auth_time`. Refreshing keeps the original value, so a refreshed token does not look like a
 * fresh sign-in.
 */
const AUTH_TIME_MAPPER = {
  name: 'auth_time',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-usersessionmodel-note-mapper',
  config: {
    'user.session.note': 'AUTH_TIME',
    'claim.name': 'auth_time',
    'jsonType.label': 'long',
    'id.token.claim': 'true',
    'access.token.claim': 'true',
    'userinfo.token.claim': 'false',
  },
};

/**
 * The claims a GoTrue client expects in an access token, produced by the
 * project's public clients (docs/specs/supabase-compat-auth.md §5).
 *
 * `app_metadata` and `user_metadata` are JSON user attributes copied verbatim;
 * `role` is what RLS reads as `auth.role()`, `aal` what `getAuthenticatorAssuranceLevel()`
 * reads, `aud` the audience supabase-js checks, `phone` the user's phoneNumber attribute.
 * The aal2 client is identical except for `aal` and the `amr` list.
 */
function jsonAttributeMapper(name: string) {
  return {
    name,
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    config: {
      'user.attribute': name,
      'claim.name': name,
      'jsonType.label': 'JSON',
      'id.token.claim': 'true',
      'access.token.claim': 'true',
      'userinfo.token.claim': 'true',
      multivalued: 'false',
      'aggregate.attrs': 'false',
    },
  };
}

function hardcodedClaimMapper(name: string, value: string, jsonType: 'String' | 'JSON' = 'String') {
  return {
    name,
    protocol: 'openid-connect',
    protocolMapper: 'oidc-hardcoded-claim-mapper',
    config: {
      'claim.name': name,
      'claim.value': value,
      'jsonType.label': jsonType,
      'id.token.claim': 'true',
      'access.token.claim': 'true',
      'userinfo.token.claim': 'true',
    },
  };
}

const AUTHENTICATED_AUDIENCE_MAPPER = {
  name: 'aud-authenticated',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  config: {
    'included.custom.audience': 'authenticated',
    'id.token.claim': 'false',
    'access.token.claim': 'true',
  },
};

const PHONE_CLAIM_MAPPER = {
  name: 'phone',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-usermodel-attribute-mapper',
  config: {
    'user.attribute': 'phoneNumber',
    'claim.name': 'phone',
    'jsonType.label': 'String',
    'id.token.claim': 'true',
    'access.token.claim': 'true',
    'userinfo.token.claim': 'true',
    multivalued: 'false',
    'aggregate.attrs': 'false',
  },
};

export type AssuranceLevel = 'aal1' | 'aal2';

/** The GoTrue claim mappers of one public client; `aal2` adds the `amr` list. */
export function goTrueClientMappers(aal: AssuranceLevel) {
  return [
    jsonAttributeMapper('app_metadata'),
    jsonAttributeMapper('user_metadata'),
    hardcodedClaimMapper('role', 'authenticated'),
    hardcodedClaimMapper('aal', aal),
    ...(aal === 'aal2' ? [hardcodedClaimMapper('amr', '[{"method":"totp"}]', 'JSON')] : []),
    AUTHENTICATED_AUDIENCE_MAPPER,
    PHONE_CLAIM_MAPPER,
  ];
}

/** `${realm}-anon` for aal1 sessions, `${realm}-anon-aal2` for sessions that passed a second factor. */
export function realmPublicClientId(realmName: string, aal: AssuranceLevel = 'aal1'): string {
  return aal === 'aal2' ? `${realmName}-anon-aal2` : `${realmName}-anon`;
}

/** What `app_metadata` says about a user nothing else has been recorded for. */
export const DEFAULT_APP_METADATA = { provider: 'email', providers: ['email'] };

export interface MintedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

/** Client attribute behind "Always use lightweight access token" (Keycloak 23+). */
const LIGHTWEIGHT_ACCESS_TOKEN = 'client.use.lightweight.access.token.enabled';

@Injectable()
export class KeycloakAdminService implements OnModuleInit {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private client!: KcAdminClient;

  constructor(private readonly config: ConfigService) {}

  /**
   * Retry an async operation with exponential backoff.
   * Retries on network errors / 5xx responses (transient); throws immediately on 4xx (permanent).
   */
  private async withRetry<T>(
    label: string,
    fn: () => Promise<T>,
    maxAttempts = 3,
    baseDelayMs = 1000,
  ): Promise<T> {
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        const status = err?.response?.status ?? err?.status;
        // Don't retry client errors (4xx) – they won't resolve on retry
        if (status && status >= 400 && status < 500) {
          throw err;
        }
        if (attempt < maxAttempts) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          this.logger.warn(
            `${label}: attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delay}ms…`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    this.logger.error(`${label}: all ${maxAttempts} attempts failed`);
    throw lastErr;
  }

  async onModuleInit() {
    this.client = new KcAdminClient({
      baseUrl: this.config.get<string>('keycloak.url'),
    });
    await this.authenticate();
    this.logger.log('Keycloak admin client initialized');
    await this.ensureSignInClientFullTokens();
    await this.ensureRealmTokenLifespan();
    await this.ensureAutoLinkFlow('master');
    await this.ensurePlatformOAuthClient();
    await this.ensurePlatformIdentityProviders();
    await this.ensureRealmSmtp();
  }

  /**
   * With KEYCLOAK_REALM_SMTP=true and the platform on SMTP, every realm gets the
   * same server, so the mail Keycloak sends itself — the password reset and
   * verification links of its login pages — can leave too. Off by default:
   * realms keep whatever they had. Idempotent; never fails the boot.
   */
  private async ensureRealmSmtp(): Promise<void> {
    const smtp = realmSmtpServer(this.config);
    if (!smtp) return;
    try {
      const realms = await this.client.realms.find();
      let updated = 0;
      for (const realm of realms) {
        const current = (realm.smtpServer ?? {}) as Record<string, string>;
        const same = Object.keys(smtp).every((k) => k === 'password' || String(current[k] ?? '') === String(smtp[k]));
        if (same && current.host) continue;
        await this.client.realms.update({ realm: realm.realm! }, { smtpServer: smtp });
        updated++;
      }
      if (updated) this.logger.log(`SMTP settings written to ${updated} realm(s)`);
    } catch (err: any) {
      this.logger.warn(`Could not write SMTP settings to the realms: ${err?.message ?? err}`);
    }
  }

  /**
   * Platform sign-in is a password grant on the master realm's admin client
   * (keycloak.adminClientId, admin-cli), and every guarded route reads `sub` and
   * `email` from that token. Keycloak 25+ creates admin-cli with lightweight
   * access tokens, and its 26.0.0 migration switches them on for existing
   * realms too: those tokens carry neither claim, so nobody could use the
   * dashboard. Turn it back off — only when it is on, so a Keycloak 24 server
   * (where it never is) sees no write. Never fails the boot.
   */
  private async ensureSignInClientFullTokens(): Promise<void> {
    const clientId = this.config.get<string>('keycloak.adminClientId') || 'admin-cli';
    try {
      const [c] = await this.client.clients.find({ realm: 'master', clientId });
      const attributes = (c?.attributes ?? {}) as Record<string, string>;
      if (!c?.id || String(attributes[LIGHTWEIGHT_ACCESS_TOKEN]) !== 'true') return;
      await this.client.clients.update(
        { realm: 'master', id: c.id },
        { ...c, attributes: { ...attributes, [LIGHTWEIGHT_ACCESS_TOKEN]: 'false' } },
      );
      this.logger.log(`Lightweight access tokens switched off on "${clientId}" (platform sign-in needs sub and email)`);
    } catch (err: any) {
      this.logger.warn(`Could not check the token settings of "${clientId}": ${err?.message ?? err}`);
    }
  }

  private async ensureRealmTokenLifespan() {
    try {
      const realm = await this.client.realms.findOne({ realm: 'master' });
      const updates: Record<string, unknown> = {};
      if (realm && realm.accessTokenLifespan && realm.accessTokenLifespan < 1800) {
        updates.accessTokenLifespan = 1800;
      }
      if (realm && !realm.loginWithEmailAllowed) {
        updates.loginWithEmailAllowed = true;
      }
      // Keep sessions alive for 30 days so users stay logged in until explicit logout.
      // SSO session idle = 30 days (how long a session survives without activity).
      // SSO session max  = 30 days (absolute cap regardless of activity).
      // Offline session idle = 30 days (refresh tokens for CLI / long-lived sessions).
      const THIRTY_DAYS = 30 * 24 * 60 * 60; // 2_592_000 seconds
      if (!realm?.ssoSessionIdleTimeout || realm.ssoSessionIdleTimeout < THIRTY_DAYS) {
        updates.ssoSessionIdleTimeout = THIRTY_DAYS;
      }
      if (!realm?.ssoSessionMaxLifespan || realm.ssoSessionMaxLifespan < THIRTY_DAYS) {
        updates.ssoSessionMaxLifespan = THIRTY_DAYS;
      }
      if (!realm?.offlineSessionIdleTimeout || realm.offlineSessionIdleTimeout < THIRTY_DAYS) {
        updates.offlineSessionIdleTimeout = THIRTY_DAYS;
      }
      if (Object.keys(updates).length > 0) {
        await this.client.realms.update({ realm: 'master' }, updates);
        this.logger.log('Master realm settings updated');
      }
    } catch (err) {
      this.logger.warn('Could not update realm settings', err);
    }
  }

  private static AUTO_LINK_FLOW_ALIAS = 'auto-link-broker';

  async ensureAutoLinkFlow(realmName: string): Promise<string> {
    const alias = KeycloakAdminService.AUTO_LINK_FLOW_ALIAS;
    try {
      const baseUrl = this.config.get<string>('keycloak.url');
      const adminToken = await this.getAdminAccessToken();
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
      const authBase = `${baseUrl}/admin/realms/${realmName}/authentication`;

      const { data: flows } = await axios.get(`${authBase}/flows`, { headers });
      const existing = flows.find((f: any) => f.alias === alias);

      if (existing) {
        const { data: executions } = await axios.get(
          `${authBase}/flows/${alias}/executions`, { headers },
        );
        const hasCreateUnique = executions.some((e: any) => e.providerId === 'idp-create-user-if-unique');
        const hasAutoLink = executions.some((e: any) => e.providerId === 'idp-auto-link');

        if (hasCreateUnique && hasAutoLink) {
          this.logger.log(`Flow "${alias}" already correct`);
          return alias;
        }

        this.logger.log(`Flow "${alias}" has wrong executions, fixing...`);
        for (const exec of executions) {
          try {
            await axios.delete(`${authBase}/executions/${exec.id}`, { headers });
          } catch { /* ignore */ }
        }
      } else {
        this.logger.log(`Creating "${alias}" flow...`);
        await axios.post(`${authBase}/flows`, {
          alias,
          description: 'Auto-link brokered accounts to existing accounts with same email',
          providerId: 'basic-flow',
          topLevel: true,
          builtIn: false,
        }, { headers });
      }

      await axios.post(`${authBase}/flows/${alias}/executions/execution`, {
        provider: 'idp-create-user-if-unique',
      }, { headers });

      await axios.post(`${authBase}/flows/${alias}/executions/execution`, {
        provider: 'idp-auto-link',
      }, { headers });

      const { data: executions } = await axios.get(
        `${authBase}/flows/${alias}/executions`, { headers },
      );
      for (const exec of executions) {
        await axios.put(`${authBase}/flows/${alias}/executions`, {
          ...exec,
          requirement: 'ALTERNATIVE',
        }, { headers });
      }

      const { data: finalExecs } = await axios.get(`${authBase}/flows/${alias}/executions`, { headers });
      this.logger.log(
        `Flow "${alias}" final: ${finalExecs.map((e: any) => `${e.providerId}=${e.requirement}`).join(', ')}`,
      );
    } catch (err: any) {
      this.logger.error(
        `FAILED to ensure auto-link flow for "${realmName}": ${err.response?.data?.errorMessage || err.response?.data?.error || err.message}`,
      );
    }
    return alias;
  }

  private async getAdminAccessToken(): Promise<string> {
    const baseUrl = this.config.get<string>('keycloak.url');
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.get<string>('keycloak.adminClientId')!,
      username: this.config.get<string>('keycloak.adminUser')!,
      password: this.config.get<string>('keycloak.adminPassword')!,
    });
    const { data } = await axios.post(
      `${baseUrl}/realms/master/protocol/openid-connect/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return data.access_token;
  }

  private async ensurePlatformOAuthClient() {
    try {
      const clientId = this.getPlatformOAuthClientId();
      const publicApiUrl = this.config.get<string>('publicApiUrl') || 'http://localhost:4000';
      const appUrl = this.config.get<string>('appUrl') || 'http://localhost:3000';
      const callbackUrl = `${publicApiUrl}/api/auth/oauth/callback`;
      const appOrigin = (() => {
        try {
          return new URL(appUrl).origin;
        } catch {
          return 'http://localhost:3000';
        }
      })();

      const redirectUris = Array.from(
        new Set([
          callbackUrl,
          `${appOrigin}/*`,
          `${appOrigin}/login`,
          'http://localhost:3000/*',
          'http://localhost:3000/login',
          'http://127.0.0.1:3000/*',
          'http://127.0.0.1:3000/login',
        ]),
      );
      const webOrigins = Array.from(
        new Set([
          appOrigin,
          'http://localhost:3000',
          'http://127.0.0.1:3000',
          publicApiUrl,
          '+',
        ]),
      );

      /** Keycloak requires explicit post-logout URIs (wildcards on redirectUris are not enough). */
      const postLogoutUris = new Set<string>([
        `${appOrigin}/login`,
        'http://localhost:3000/login',
        'http://127.0.0.1:3000/login',
      ]);
      const extraRaw = this.config.get<string>('keycloak.postLogoutRedirectUrisExtra') || '';
      for (const part of extraRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
        postLogoutUris.add(part);
      }
      const postLogoutRedirectUris = Array.from(postLogoutUris).join('##');

      const existing = await this.client.clients.find({ realm: 'master', clientId });
      if (existing.length > 0) {
        const prev = existing[0];
        const attributes = {
          ...(prev.attributes || {}),
          'post.logout.redirect.uris': postLogoutRedirectUris,
        };
        await this.client.clients.update(
          { realm: 'master', id: prev.id! },
          {
            ...prev,
            clientId,
            publicClient: true,
            standardFlowEnabled: true,
            directAccessGrantsEnabled: false,
            redirectUris,
            webOrigins,
            attributes,
          },
        );
        this.logger.log('Platform OAuth client updated');
      } else {
        await this.client.clients.create({
          realm: 'master',
          clientId,
          publicClient: true,
          standardFlowEnabled: true,
          directAccessGrantsEnabled: false,
          redirectUris,
          webOrigins,
          attributes: {
            'post.logout.redirect.uris': postLogoutRedirectUris,
          },
        });
        this.logger.log('Platform OAuth client created');
      }
    } catch (err: any) {
      this.logger.warn(`Could not ensure platform OAuth client: ${err.message}`);
    }
  }

  private async ensurePlatformIdentityProviders() {
    const flowAlias = KeycloakAdminService.AUTO_LINK_FLOW_ALIAS;
    const baseUrl = this.config.get<string>('keycloak.url');
    const adminToken = await this.getAdminAccessToken();
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    const idpBase = `${baseUrl}/admin/realms/master/identity-provider/instances`;

    const providers = [
      {
        alias: 'google',
        providerId: 'google',
        envId: 'oauth.googleClientId',
        envSecret: 'oauth.googleClientSecret',
        scope: 'openid email profile',
        // Account chooser + fresh auth (avoids wrong-account SSO with Keycloak broker).
        extraConfig: { prompt: 'select_account login', max_age: '0' },
      },
      {
        alias: 'github',
        providerId: 'github',
        envId: 'oauth.githubClientId',
        envSecret: 'oauth.githubClientSecret',
        scope: 'user:email',
        extraConfig: { prompt: 'login', max_age: '0' },
      },
    ];

    for (const p of providers) {
      const clientId = this.config.get<string>(p.envId);
      const clientSecret = this.config.get<string>(p.envSecret);
      if (!clientId || !clientSecret) continue;

      const idpBody = {
        alias: p.alias,
        providerId: p.providerId,
        enabled: true,
        trustEmail: true,
        firstBrokerLoginFlowAlias: flowAlias,
        config: { clientId, clientSecret, defaultScope: p.scope, ...p.extraConfig },
      };

      try {
        const existing = await axios.get(`${idpBase}/${p.alias}`, { headers }).catch(() => null);
        if (existing?.data) {
          await axios.put(`${idpBase}/${p.alias}`, idpBody, { headers });
          this.logger.log(`Platform ${p.alias} IdP updated`);
        } else {
          await axios.post(idpBase, idpBody, { headers });
          this.logger.log(`Platform ${p.alias} IdP created`);
        }
      } catch (err: any) {
        this.logger.error(`Could not configure platform ${p.alias} IdP: ${err.response?.data?.errorMessage || err.message}`);
      }
    }
  }

  getPlatformOAuthClientId(): string {
    return this.config.get<string>('platformKeycloakClientId') || 'kolaybase-platform';
  }

  getEnabledPlatformProviders(): string[] {
    const result: string[] = [];
    if (this.config.get<string>('oauth.googleClientId')) result.push('google');
    if (this.config.get<string>('oauth.githubClientId')) result.push('github');
    return result;
  }

  private async authenticate() {
    await this.client.auth({
      username: this.config.get<string>('keycloak.adminUser')!,
      password: this.config.get<string>('keycloak.adminPassword')!,
      grantType: 'password',
      clientId: this.config.get<string>('keycloak.adminClientId')!,
    });
  }

  private async ensureAuth() {
    try {
      await this.withRetry('ensureAuth', () => this.authenticate());
    } catch (err: any) {
      this.logger.error('Failed to re-authenticate with Keycloak', err);
      throw new InternalServerErrorException(
        `Keycloak authentication failed: ${err.message || 'unknown error'}`,
      );
    }
  }

  private async resolvePlatformUserId(
    userId: string,
    email?: string,
  ): Promise<string> {
    const byId = await this.client.users.findOne({ realm: 'master', id: userId });
    if (byId?.id) return byId.id;
    if (email) {
      const byEmail = await this.findPlatformUserByEmail(email);
      if (byEmail?.id) return byEmail.id;
    }
    throw new InternalServerErrorException('Platform user not found in Keycloak');
  }

  /**
   * Quick connectivity check — authenticates and lists realms.
   * Throws with a descriptive message if Keycloak is unreachable or credentials are wrong.
   */
  async assertHealthy(): Promise<void> {
    try {
      await this.withRetry('healthCheck', async () => {
        await this.authenticate();
        await this.client.realms.find();
      });
    } catch (err: any) {
      const url = this.config.get<string>('keycloak.url');
      throw new InternalServerErrorException(
        `Keycloak is not reachable at ${url}: ${err.message || 'unknown error'}`,
      );
    }
  }

  // ── Realm operations ──

  async createRealm(realmName: string): Promise<void> {
    await this.ensureAuth();
    // If a disabled (archived) realm with this name exists, remove it first
    // so we can create a fresh one without conflict.
    const exists = await this.realmExists(realmName);
    if (exists) {
      this.logger.warn(`Realm "${realmName}" already exists, deleting before recreate`);
      await this.client.realms.del({ realm: realmName });
      // Re-authenticate after delete to ensure a fresh token for the create call
      await this.ensureAuth();
      // Wait briefly for Keycloak to fully clean up internal state (caches, JPA flush)
      await new Promise((r) => setTimeout(r, 2000));
    }
    await this.withRetry(`createRealm(${realmName})`, () =>
      this.client.realms.create({
        realm: realmName,
        enabled: true,
        registrationAllowed: true,
        loginWithEmailAllowed: true,
        duplicateEmailsAllowed: false,
        verifyEmail: false,
        accessTokenLifespan: 1800,
        ssoSessionIdleTimeout: 2592000,  // 30 days
        ssoSessionMaxLifespan: 2592000,  // 30 days
        offlineSessionIdleTimeout: 2592000, // 30 days
        ...(realmSmtpServer(this.config) ? { smtpServer: realmSmtpServer(this.config)! } : {}),
      }),
    );

    try {
      const baseUrl = this.config.get<string>('keycloak.url');
      const adminToken = await this.getAdminAccessToken();
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
      const { data: actions } = await axios.get(
        `${baseUrl}/admin/realms/${realmName}/authentication/required-actions`,
        { headers },
      );
      for (const action of actions) {
        if (action.alias === 'VERIFY_EMAIL' && action.defaultAction) {
          await axios.put(
            `${baseUrl}/admin/realms/${realmName}/authentication/required-actions/${action.alias}`,
            { ...action, defaultAction: false },
            { headers },
          );
        }
      }
    } catch (err: any) {
      this.logger.warn(`Could not disable VERIFY_EMAIL default action: ${err.message}`);
    }

    this.logger.log(`Realm "${realmName}" created`);
  }

  /**
   * Register the OAuth callback on a project's anon client.
   *
   * The anon client is created with the standard flow enabled but no redirect
   * URIs, and Keycloak refuses an authorization request whose redirect_uri
   * matches nothing — so every social sign-in failed with "Invalid parameter:
   * redirect_uri" on every project that configured one. Email and password
   * sign-in kept working, because that uses the direct grant and never
   * redirects, which is why the gap went unnoticed.
   *
   * The project id is not known when the client is created — the row does not
   * exist yet — so the URI is written here instead, at the one moment both the
   * realm and the project are known: just before an authorization request is
   * handed out. Idempotent, so it costs one read on every sign-in after the
   * first and repairs a client that predates the fix.
   *
   * Only the exact callback for this project is added, with the wildcard
   * confined to the provider segment. A broader pattern on a redirect URI is
   * an open redirect, which is the hole this kind of setting usually opens.
   */
  async ensureAnonClientRedirectUri(
    realmName: string,
    callbackUri: string,
    clientId: string = `${realmName}-anon`,
  ): Promise<void> {
    await this.ensureAuth();
    const anonClientId = clientId;

    const found = await this.withRetry(`findClient(${anonClientId})`, () =>
      this.client.clients.find({ realm: realmName, clientId: anonClientId }),
    );
    const existing = found?.[0];
    if (!existing?.id) {
      this.logger.warn(
        `Cannot register the OAuth callback: client "${anonClientId}" does not exist in realm "${realmName}"`,
      );
      return;
    }

    const current = existing.redirectUris ?? [];
    if (current.includes(callbackUri)) return;

    await this.withRetry(`updateClientRedirectUris(${anonClientId})`, () =>
      this.client.clients.update(
        { realm: realmName, id: existing.id! },
        { ...existing, redirectUris: [...current, callbackUri] },
      ),
    );
    this.logger.log(`Registered OAuth callback on "${anonClientId}": ${callbackUri}`);
  }

  async createClients(realmName: string): Promise<ProjectClients> {
    await this.ensureAuth();

    const anonClientId = `${realmName}-anon`;
    const serviceClientId = `${realmName}-service`;

    await this.withRetry(`createClient(${anonClientId})`, () =>
      this.client.clients.create({
        realm: realmName,
        clientId: anonClientId,
        enabled: true,
        publicClient: true,
        directAccessGrantsEnabled: true,
        standardFlowEnabled: true,
        protocolMappers: [AUTH_TIME_MAPPER, ...goTrueClientMappers('aal1')],
      }),
    );

    // A session that passed a second factor is minted through this twin of the
    // anon client; the only difference is what its tokens say about `aal`.
    await this.createAal2Client(realmName);

    const serviceSecret = uuid();
    await this.withRetry(`createClient(${serviceClientId})`, () =>
      this.client.clients.create({
        realm: realmName,
        clientId: serviceClientId,
        enabled: true,
        publicClient: false,
        serviceAccountsEnabled: true,
        directAccessGrantsEnabled: true,
        secret: serviceSecret,
      }),
    );

    this.logger.log(`Clients created for realm "${realmName}"`);

    const anonKey = `bf_anon_${randomBytes(32).toString('base64url')}`;
    const serviceKey = `bf_service_${randomBytes(32).toString('base64url')}`;
    return { anonKey, serviceKey };
  }

  private async createAal2Client(realmName: string): Promise<void> {
    const clientId = realmPublicClientId(realmName, 'aal2');
    await this.withRetry(`createClient(${clientId})`, () =>
      this.client.clients.create({
        realm: realmName,
        clientId,
        enabled: true,
        publicClient: true,
        directAccessGrantsEnabled: true,
        standardFlowEnabled: true,
        protocolMappers: [AUTH_TIME_MAPPER, ...goTrueClientMappers('aal2')],
      }),
    );
  }

  /** Realms whose public clients are known to carry the GoTrue claim mappers in this process. */
  private readonly goTrueMapped = new Set<string>();

  /**
   * Make a public client of the realm produce GoTrue-shaped tokens. Realms created before the
   * mappers were part of createClients get them on their first sign-in through the facade; a
   * missing aal2 client is created outright. Idempotent and cached per process.
   */
  async ensureRealmClientGoTrueMappers(realmName: string, clientId: string): Promise<void> {
    const key = `${realmName}/${clientId}`;
    if (this.goTrueMapped.has(key)) return;
    await this.ensureAuth();
    const aal: AssuranceLevel = clientId === realmPublicClientId(realmName, 'aal2') ? 'aal2' : 'aal1';
    let [c] = await this.client.clients.find({ realm: realmName, clientId });
    if (!c?.id && aal === 'aal2') {
      await this.createAal2Client(realmName);
      [c] = await this.client.clients.find({ realm: realmName, clientId });
    }
    if (!c?.id) {
      throw new BadRequestException(`Client "${clientId}" does not exist in realm "${realmName}"`);
    }
    const present = new Set(
      (await this.client.clients.listProtocolMappers({ realm: realmName, id: c.id })).map((m) => m.name),
    );
    for (const mapper of goTrueClientMappers(aal)) {
      if (present.has(mapper.name)) continue;
      await this.client.clients.addProtocolMapper({ realm: realmName, id: c.id }, mapper);
      this.logger.log(`Added ${mapper.name} mapper to "${clientId}" in realm "${realmName}"`);
    }
    this.goTrueMapped.add(key);
  }

  /**
   * Everything the GoTrue facade needs from a realm, for the repair routes: both public
   * clients with their mappers, and custom attributes writable. Each step is best-effort
   * and reported, so one failure does not hide the others.
   */
  async ensureRealmGoTrueCompat(realmName: string): Promise<string[]> {
    const problems: string[] = [];
    for (const aal of ['aal1', 'aal2'] as AssuranceLevel[]) {
      const clientId = realmPublicClientId(realmName, aal);
      try {
        this.goTrueMapped.delete(`${realmName}/${clientId}`);
        await this.ensureRealmClientGoTrueMappers(realmName, clientId);
      } catch (err: any) {
        problems.push(`${clientId}: ${err?.message ?? err}`);
      }
    }
    await this.ensureUnmanagedAttributes(realmName);
    return problems;
  }

  /**
   * How long the access tokens of a realm live (ProjectAuthConfig.tokenExpirySeconds). The
   * realm's SSO session (30 days) bounds the refresh token and is left alone.
   */
  async setRealmAccessTokenLifespan(realmName: string, seconds: number): Promise<void> {
    await this.ensureAuth();
    const lifespan = Math.max(60, Math.min(Math.floor(seconds), 30 * 24 * 60 * 60));
    await this.client.realms.update({ realm: realmName }, { accessTokenLifespan: lifespan });
    this.logger.log(`Realm "${realmName}" access token lifespan set to ${lifespan}s`);
  }

  async deleteRealm(realmName: string): Promise<void> {
    await this.ensureAuth();
    await this.client.realms.del({ realm: realmName });
    this.logger.log(`Realm "${realmName}" deleted`);
  }

  async disableRealm(realmName: string): Promise<void> {
    await this.ensureAuth();
    await this.client.realms.update({ realm: realmName }, { enabled: false });
    this.logger.log(`Realm "${realmName}" disabled`);
  }

  async enableRealm(realmName: string): Promise<void> {
    await this.ensureAuth();
    await this.client.realms.update({ realm: realmName }, { enabled: true });
    this.logger.log(`Realm "${realmName}" enabled`);
  }

  async realmExists(realmName: string): Promise<boolean> {
    await this.ensureAuth();
    try {
      const realm = await this.client.realms.findOne({ realm: realmName });
      return !!realm;
    } catch {
      return false;
    }
  }

  async getRealmInfo(realmName: string) {
    await this.ensureAuth();
    const realm = await this.client.realms.findOne({ realm: realmName });
    if (!realm) {
      this.logger.error(`Realm "${realmName}" not found in Keycloak`);
      throw new InternalServerErrorException(
        `Authentication realm "${realmName}" not found. The realm may need to be re-provisioned.`,
      );
    }
    const users = await this.client.users.count({ realm: realmName });
    const clients = await this.client.clients.find({ realm: realmName });

    return {
      name: realm?.realm,
      enabled: realm?.enabled,
      userCount: users,
      clientCount: clients.length,
      registrationAllowed: realm?.registrationAllowed,
      loginWithEmailAllowed: realm?.loginWithEmailAllowed,
    };
  }

  // ── Realm user operations ──

  async listUsers(realmName: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({ realm: realmName, briefRepresentation: false });
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: u.enabled,
      emailVerified: u.emailVerified,
      phoneNumber: (u.attributes as any)?.phoneNumber?.[0] ?? null,
      phoneVerified: (u.attributes as any)?.phoneVerified?.[0] === 'true',
      isAnonymous: this.isAnonymousUser(u),
      createdTimestamp: u.createdTimestamp,
    }));
  }

  // ── Sessions / providers / lifecycle emails (Supabase-style auth dashboard) ──

  /** Active sessions for a single realm user. */
  async listUserSessions(realmName: string, userId: string) {
    await this.ensureAuth();
    const sessions = await this.client.users.listSessions({ realm: realmName, id: userId });
    const mapped = (sessions || []).map((s: any) => ({
      id: s.id,
      ipAddress: s.ipAddress ?? null,
      start: s.start ?? null,
      lastAccess: s.lastAccess ?? null,
      clients: s.clients ? Object.values(s.clients) : [],
      location: null as string | null,
    }));
    return this.enrichGeo(mapped);
  }

  /** Revoke one specific session (Keycloak has no admin-client wrapper for this). */
  async revokeUserSession(realmName: string, sessionId: string) {
    await this.ensureAuth();
    const baseUrl = this.config.get<string>('keycloak.url');
    const adminToken = await this.getAdminAccessToken();
    await axios.delete(`${baseUrl}/admin/realms/${realmName}/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    return { message: 'Session revoked' };
  }

  /** Sign the user out of all sessions. */
  async logoutAllUserSessions(realmName: string, userId: string) {
    await this.ensureAuth();
    await this.client.users.logout({ realm: realmName, id: userId });
    return { message: 'All sessions signed out' };
  }

  /** OAuth/identity providers the user has linked (e.g. google, github). */
  async listUserFederatedIdentities(realmName: string, userId: string): Promise<string[]> {
    await this.ensureAuth();
    const fis = await this.client.users.listFederatedIdentities({ realm: realmName, id: userId });
    return (fis || []).map((f: any) => f.identityProvider).filter(Boolean);
  }

  /** Send a lifecycle email (UPDATE_PASSWORD = recovery, VERIFY_EMAIL = confirm). */
  async sendUserActionsEmail(realmName: string, userId: string, actions: string[]) {
    await this.ensureAuth();
    await this.client.users.executeActionsEmail({
      realm: realmName,
      id: userId,
      actions: actions as any,
      lifespan: 12 * 60 * 60,
    });
    return { message: 'Email sent' };
  }

  /** Add/remove a required action (e.g. CONFIGURE_TOTP to force MFA enrollment). */
  async setUserRequiredAction(realmName: string, userId: string, action: string, enabled: boolean) {
    await this.ensureAuth();
    const u = await this.client.users.findOne({ realm: realmName, id: userId });
    const current = new Set<string>((u?.requiredActions as string[]) || []);
    if (enabled) current.add(action);
    else current.delete(action);
    await this.client.users.update(
      { realm: realmName, id: userId },
      { requiredActions: Array.from(current) as any },
    );
    return { message: enabled ? 'Required action added' : 'Required action removed' };
  }

  private geoCache = new Map<string, string>();

  private isPrivateIp(ip: string): boolean {
    return (
      !ip ||
      ip === '127.0.0.1' ||
      ip === '::1' ||
      /^10\./.test(ip) ||
      /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
      ip.startsWith('fc') ||
      ip.startsWith('fd')
    );
  }

  /** Best-effort IP → "City, Country" (cached). Returns 'internal' for private IPs. */
  private async geoLookup(ip: string | null): Promise<string | null> {
    if (!ip) return null;
    if (this.isPrivateIp(ip)) return 'internal';
    if (this.geoCache.has(ip)) return this.geoCache.get(ip)!;
    try {
      const { data } = await axios.get(`https://ipwho.is/${ip}?fields=success,city,country`, {
        timeout: 2500,
      });
      if (data?.success) {
        const loc = [data.city, data.country].filter(Boolean).join(', ') || null;
        if (loc) this.geoCache.set(ip, loc);
        return loc;
      }
    } catch {
      /* ignore — geo is best-effort */
    }
    return null;
  }

  private async enrichGeo<T extends { ipAddress: string | null; location?: string | null }>(
    sessions: T[],
  ): Promise<T[]> {
    await Promise.all(
      sessions.map(async (s) => {
        s.location = await this.geoLookup(s.ipAddress);
      }),
    );
    return sessions;
  }

  /** All active sessions in the realm (aggregated across the project's clients). */
  async listRealmSessions(realmName: string) {
    await this.ensureAuth();
    const baseUrl = this.config.get<string>('keycloak.url');
    const adminToken = await this.getAdminAccessToken();
    const headers = { Authorization: `Bearer ${adminToken}` };
    const clients = await this.client.clients.find({ realm: realmName });
    const wanted = clients.filter(
      (c) => c.clientId?.endsWith('-anon') || c.clientId?.endsWith('-service'),
    );
    const byId = new Map<string, any>();
    for (const c of wanted) {
      try {
        const { data } = await axios.get(
          `${baseUrl}/admin/realms/${realmName}/clients/${c.id}/user-sessions?first=0&max=200`,
          { headers },
        );
        for (const s of data || []) {
          if (!byId.has(s.id)) {
            byId.set(s.id, {
              id: s.id,
              userId: s.userId ?? null,
              username: s.username ?? null,
              ipAddress: s.ipAddress ?? null,
              start: s.start ?? null,
              lastAccess: s.lastAccess ?? null,
              clients: s.clients ? Object.values(s.clients) : [],
            });
          }
        }
      } catch {
        /* skip this client */
      }
    }
    const arr = Array.from(byId.values()).sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));
    return this.enrichGeo(arr);
  }

  /** Credentials configured for a user (password / otp / webauthn). */
  async getUserCredentials(realmName: string, userId: string) {
    await this.ensureAuth();
    const creds = await this.client.users.getCredentials({ realm: realmName, id: userId });
    return (creds || []).map((c: any) => ({
      id: c.id,
      type: c.type,
      userLabel: c.userLabel ?? null,
      createdDate: c.createdDate ?? null,
    }));
  }

  /** Remove a credential (used to reset a user's MFA factor). */
  async removeUserCredential(realmName: string, userId: string, credentialId: string) {
    await this.ensureAuth();
    await this.client.users.deleteCredential({ realm: realmName, id: userId, credentialId });
    return { message: 'Credential removed' };
  }

  /** Users that have at least one MFA factor (OTP / WebAuthn) enrolled. */
  async listMfaUsers(realmName: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({ realm: realmName, max: 200 });
    const out: any[] = [];
    for (const u of users) {
      if (!u.id) continue;
      try {
        const creds = await this.client.users.getCredentials({ realm: realmName, id: u.id });
        const factors = (creds || []).filter((c: any) => c.type && c.type !== 'password');
        if (factors.length) {
          out.push({
            id: u.id,
            email: u.email,
            firstName: u.firstName,
            lastName: u.lastName,
            factors: factors.map((c: any) => ({
              id: c.id,
              type: c.type,
              userLabel: c.userLabel ?? null,
              createdDate: c.createdDate ?? null,
            })),
          });
        }
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** Brute-force / lockout + password policy for the realm. */
  async getRealmPolicies(realmName: string) {
    await this.ensureAuth();
    const r = await this.client.realms.findOne({ realm: realmName });
    return {
      bruteForceProtected: !!r?.bruteForceProtected,
      permanentLockout: !!r?.permanentLockout,
      failureFactor: r?.failureFactor ?? 30,
      waitIncrementSeconds: r?.waitIncrementSeconds ?? 60,
      maxFailureWaitSeconds: r?.maxFailureWaitSeconds ?? 900,
      passwordPolicy: r?.passwordPolicy ?? '',
    };
  }

  async updateRealmPolicies(realmName: string, data: Record<string, any>) {
    await this.ensureAuth();
    const update: Record<string, any> = {};
    for (const k of [
      'bruteForceProtected',
      'permanentLockout',
      'failureFactor',
      'waitIncrementSeconds',
      'maxFailureWaitSeconds',
      'passwordPolicy',
    ]) {
      if (data[k] !== undefined) update[k] = data[k];
    }
    await this.client.realms.update({ realm: realmName }, update);
    this.logger.log(`Realm "${realmName}" policies updated`);
    return { message: 'Policies updated' };
  }

  async createUser(
    realmName: string,
    data: { email: string; password: string; firstName?: string; lastName?: string; username?: string },
  ) {
    await this.ensureAuth();

    await this.client.users.create({
      realm: realmName,
      username: data.email,
      email: data.email,
      // Keycloak 24's User Profile requires firstName/lastName; empty values make
      // the password grant fail with "Account is not fully set up". Fall back to
      // the email local part so the account is always login-ready.
      firstName: data.firstName?.trim() || data.email.split('@')[0] || 'user',
      lastName: data.lastName?.trim() || data.email.split('@')[0] || 'user',
      enabled: true,
      emailVerified: true,
      // Explicitly clear required actions so the realm's DEFAULT required actions
      // (e.g. VERIFY_EMAIL / UPDATE_PASSWORD on older realms) aren't auto-applied,
      // which would make the password grant fail with invalid_grant on signin.
      requiredActions: [],
      credentials: [
        { type: 'password', value: data.password, temporary: false },
      ],
    });

    this.logger.log(`User "${data.email}" created in realm "${realmName}"`);
    return { message: `User created in realm` };
  }

  async createProjectUser(
    realmName: string,
    /** Without a password the user can only sign in through a mailed link (invite, magic link). */
    data: { email: string; password?: string; firstName?: string; lastName?: string },
    /**
     * Whether the address counts as confirmed. Required, never defaulted: this flag is what a
     * token's `email_verified` claim reports, and consumers use it to decide whether an address
     * really belongs to the person holding the token. Only a caller that has proven control of the
     * address (or a project that opted out of verification) may pass true.
     */
    emailVerified: boolean,
    /**
     * Custom attributes; `app_metadata` and `user_metadata` are what the GoTrue claim mappers
     * copy into the tokens, so they are always written (defaulted when the caller sends none)
     * and always as one JSON document each.
     */
    metadata: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown>; phone?: string } = {},
  ): Promise<string> {
    await this.ensureAuth();
    await this.ensureUnmanagedAttributes(realmName);

    const attributes: Record<string, string[]> = {
      app_metadata: [JSON.stringify(metadata.app_metadata ?? DEFAULT_APP_METADATA)],
      user_metadata: [JSON.stringify(metadata.user_metadata ?? {})],
      ...(metadata.phone ? { phoneNumber: [metadata.phone] } : {}),
    };

    const { id } = await this.client.users.create({
      realm: realmName,
      username: data.email,
      email: data.email,
      // Keycloak 24's User Profile requires firstName/lastName; empty values make
      // the password grant fail with "Account is not fully set up". Fall back to
      // the email local part so the account is always login-ready.
      firstName: data.firstName?.trim() || data.email.split('@')[0] || 'user',
      lastName: data.lastName?.trim() || data.email.split('@')[0] || 'user',
      enabled: true,
      // Never unconditionally true. A self-registered address is unconfirmed until the
      // project's OTP flow (verifyEmail / magic link) proves the person controls it; marking it
      // verified here put `email_verified: true` in the tokens of accounts registered under
      // somebody else's address.
      emailVerified,
      requiredActions: [],
      attributes,
      credentials: data.password
        ? [{ type: 'password', value: data.password, temporary: false }]
        : [],
    });

    this.logger.log(`Project user "${data.email}" created in realm "${realmName}" (${id})`);
    return id;
  }

  /** The whole Keycloak representation (attributes included), or null. */
  async getRealmUserRepresentation(realmName: string, userId: string) {
    await this.ensureAuth();
    const user = await this.client.users.findOne({ realm: realmName, id: userId });
    return user ?? null;
  }

  /**
   * One page of a realm's users with their attributes, and the realm's user count — what
   * `GET /auth/v1/admin/users` lists. `first` is an offset, `max` the page size.
   */
  async listRealmUsersPage(realmName: string, first: number, max: number) {
    await this.ensureAuth();
    const [users, total] = await Promise.all([
      this.client.users.find({ realm: realmName, first, max, briefRepresentation: false }),
      this.client.users.count({ realm: realmName }),
    ]);
    return { users, total };
  }

  /**
   * Replace some of a user's custom attributes, keeping the rest. Values are lists of strings,
   * as Keycloak stores them; an empty list removes the attribute.
   */
  /**
   * Keycloak 24+ (User Profile) treats a user update without email/firstName/lastName as
   * clearing them and adds VERIFY_PROFILE, after which a password grant answers
   * "Account is not fully set up". Every attribute-only update must carry these back.
   */
  private static profileFields(current: {
    username?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    emailVerified?: boolean;
    enabled?: boolean;
  }): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of ['username', 'email', 'firstName', 'lastName', 'emailVerified', 'enabled'] as const) {
      if (current[k] !== undefined) out[k] = current[k];
    }
    return out;
  }

  async setRealmUserAttributes(
    realmName: string,
    userId: string,
    attributes: Record<string, string[]>,
  ): Promise<void> {
    await this.ensureAuth();
    await this.ensureUnmanagedAttributes(realmName);
    const current = await this.client.users.findOne({ realm: realmName, id: userId });
    if (!current?.id) throw new BadRequestException('User not found');
    const merged: Record<string, unknown> = { ...(current.attributes || {}) };
    for (const [k, v] of Object.entries(attributes)) {
      if (v.length === 0) delete merged[k];
      else merged[k] = v;
    }
    await this.client.users.update(
      { realm: realmName, id: userId },
      { ...KeycloakAdminService.profileFields(current), attributes: merged },
    );
  }

  /** The JSON document in a user attribute, or `{}` when absent or unparsable. */
  static readJsonAttribute(
    user: { attributes?: Record<string, unknown> } | null | undefined,
    name: string,
  ): Record<string, unknown> {
    const raw = (user?.attributes as any)?.[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (typeof text !== 'string' || !text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Write a user's `app_metadata` / `user_metadata`. Merged into what is stored (a key set to
   * null is removed), so two callers updating different keys do not overwrite each other;
   * `replace` writes the given documents as they are. Always one JSON document per attribute —
   * the claim mappers copy the attribute verbatim, and a non-JSON value there breaks every
   * token of the user.
   */
  async setRealmUserMetadata(
    realmName: string,
    userId: string,
    data: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> },
    mode: 'merge' | 'replace' = 'merge',
  ): Promise<{ app_metadata: Record<string, unknown>; user_metadata: Record<string, unknown> }> {
    await this.ensureAuth();
    await this.ensureUnmanagedAttributes(realmName);
    const current = await this.client.users.findOne({ realm: realmName, id: userId });
    if (!current?.id) throw new BadRequestException('User not found');

    const merge = (stored: Record<string, unknown>, patch?: Record<string, unknown>) => {
      if (!patch) return stored;
      if (mode === 'replace') return { ...patch };
      const out = { ...stored };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete out[k];
        else out[k] = v;
      }
      return out;
    };
    const app_metadata = merge(
      { ...DEFAULT_APP_METADATA, ...KeycloakAdminService.readJsonAttribute(current, 'app_metadata') },
      data.app_metadata,
    );
    const user_metadata = merge(KeycloakAdminService.readJsonAttribute(current, 'user_metadata'), data.user_metadata);

    await this.client.users.update(
      { realm: realmName, id: userId },
      {
        ...KeycloakAdminService.profileFields(current),
        attributes: {
          ...(current.attributes || {}),
          app_metadata: [JSON.stringify(app_metadata)],
          user_metadata: [JSON.stringify(user_metadata)],
        },
      },
    );
    return { app_metadata, user_metadata };
  }

  /**
   * Tokens for a user who has not typed a password: a mailed link, an invitation, a step-up
   * to aal2 (docs/specs/supabase-compat-auth.md §6, option A).
   *
   * Keycloak's token exchange would be the natural tool, but it is a preview feature behind a
   * start-up flag — a restart this platform does not do for an app deploy. The admin API's
   * impersonation endpoint needs no flag on 24 or 26: it answers with the cookies of a browser
   * session for the user, and an authorization request made with those cookies and
   * `prompt=none` yields a code, which the ordinary code exchange turns into tokens for the
   * client named. The session is a real one — refresh and logout work on it like any other.
   *
   * `redirectUri` must be registered on the client (ensureAnonClientRedirectUri). Fails with a
   * 503 that says what to do when impersonation is not allowed for the admin account.
   */
  async mintSessionForUser(
    realmName: string,
    userId: string,
    clientId: string,
    redirectUri: string,
  ): Promise<MintedTokens> {
    const baseUrl = (this.config.get<string>('keycloak.url') || '').replace(/\/+$/, '');
    const unavailable = (why: string) =>
      new ServiceUnavailableException(
        `Cannot create a session without a password: Keycloak impersonation is unavailable for realm "${realmName}" (${why}). ` +
          'Allow the admin account to impersonate users of this realm, then run POST /api/projects/:projectId/auth/repair.',
      );

    let cookies: string;
    try {
      const adminToken = await this.getAdminAccessToken();
      const res = await axios.post(
        `${baseUrl}/admin/realms/${realmName}/users/${userId}/impersonation`,
        {},
        {
          headers: { Authorization: `Bearer ${adminToken}` },
          maxRedirects: 0,
          validateStatus: () => true,
        },
      );
      if (res.status >= 400) {
        throw unavailable(`impersonation answered ${res.status}${res.data?.errorMessage ? `: ${res.data.errorMessage}` : ''}`);
      }
      const setCookie = (res.headers['set-cookie'] ?? []) as string[];
      cookies = setCookie.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
      if (!cookies.includes('KEYCLOAK_IDENTITY')) throw unavailable('no identity cookie came back');
    } catch (err: any) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw unavailable(err?.message ?? String(err));
    }

    const authParams = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'none',
      redirect_uri: redirectUri,
    });
    const auth = await axios.get(
      `${baseUrl}/realms/${realmName}/protocol/openid-connect/auth?${authParams.toString()}`,
      { headers: { Cookie: cookies }, maxRedirects: 0, validateStatus: () => true },
    );
    const location = String(auth.headers['location'] ?? '');
    let code: string | null = null;
    let oauthError: string | null = null;
    try {
      const url = new URL(location, redirectUri);
      code = url.searchParams.get('code');
      oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    } catch {
      /* no usable Location */
    }
    if (!code) {
      throw unavailable(
        oauthError
          ? `the authorization request answered "${oauthError}"`
          : `the authorization request answered ${auth.status} without a code`,
      );
    }

    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
    });
    const token = await axios.post(
      `${baseUrl}/realms/${realmName}/protocol/openid-connect/token`,
      tokenParams.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true },
    );
    if (token.status >= 400 || !token.data?.access_token) {
      throw unavailable(`the code exchange answered ${token.status}: ${token.data?.error_description ?? token.data?.error ?? 'no token'}`);
    }
    return {
      accessToken: token.data.access_token,
      refreshToken: token.data.refresh_token,
      expiresIn: token.data.expires_in,
      tokenType: token.data.token_type || 'Bearer',
    };
  }

  async deleteUser(realmName: string, userId: string) {
    await this.ensureAuth();
    await this.client.users.del({ realm: realmName, id: userId });
    this.logger.log(`User "${userId}" deleted from realm "${realmName}"`);
    return { message: 'User deleted' };
  }

  async getRealmUserById(realmName: string, userId: string) {
    await this.ensureAuth();
    const user = await this.client.users.findOne({ realm: realmName, id: userId });
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerified: user.emailVerified,
      enabled: user.enabled,
      phoneNumber: (user.attributes as any)?.phoneNumber?.[0] ?? null,
      phoneVerified: (user.attributes as any)?.phoneVerified?.[0] === 'true',
      createdTimestamp: user.createdTimestamp,
    };
  }

  async findUserInRealm(realmName: string, email: string) {
    await this.ensureAuth();
    const norm = (email || '').trim().toLowerCase();
    // `exact: true` on email has been observed to miss existing users on some
    // realms (returns 0 while a broad search returns the user). Fall back to a
    // non-exact search and match the email case-insensitively. Reliability here
    // matters: it backs both the duplicate-email guard and signin's
    // email→username self-heal.
    let users = await this.client.users.find({ realm: realmName, email, exact: true });
    if (!users.length) {
      users = await this.client.users.find({ realm: realmName, email });
    }
    if (!users.length) {
      users = await this.client.users.find({ realm: realmName, search: email });
    }
    return (
      users.find((u) => (u.email || '').trim().toLowerCase() === norm) ||
      users[0] ||
      null
    );
  }

  async findUserByEmailInRealm(realm: string, email: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({ realm, email, exact: true });
    return users[0] || null;
  }

  async setEmailVerified(realmName: string, userId: string) {
    await this.ensureAuth();
    await this.client.users.update(
      { realm: realmName, id: userId },
      { emailVerified: true },
    );
    this.logger.log(`Email verified for user ${userId} in realm "${realmName}"`);
  }

  /**
   * Clear the things that make a realm user's password grant fail with
   * invalid_grant despite a correct password: an unverified email (when the
   * realm enforces verification) and pending required actions (VERIFY_EMAIL /
   * UPDATE_PASSWORD auto-applied from realm defaults). Used by signin self-heal.
   */
  async clearRealmUserLoginBlockers(realmName: string, userId: string): Promise<void> {
    await this.ensureAuth();
    const u = await this.client.users.findOne({ realm: realmName, id: userId });
    const local = (u?.email || u?.username || 'user').split('@')[0] || 'user';
    // Deliberately leaves emailVerified alone. This runs on a failed sign-in, and flipping it
    // here marked any unverified account as verified as soon as someone typed a password for it.
    const update: Record<string, unknown> = { requiredActions: [] };
    // Keycloak 24 User Profile requires firstName/lastName; fill them if empty so
    // the grant stops failing with "Account is not fully set up".
    if (!u?.firstName?.trim()) update.firstName = local;
    if (!u?.lastName?.trim()) update.lastName = local;
    await this.client.users.update({ realm: realmName, id: userId }, update);
    this.logger.log(`Cleared login blockers for user ${userId} in realm "${realmName}"`);
  }

  async resetRealmUserPassword(realmName: string, userId: string, newPassword: string) {
    await this.ensureAuth();
    await this.client.users.resetPassword({
      realm: realmName,
      id: userId,
      credential: { type: 'password', value: newPassword, temporary: false },
    });
    this.logger.log(`Password reset for user ${userId} in realm "${realmName}"`);
  }

  /**
   * Ensure a realm client has direct access grants (password grant) enabled.
   * Legacy project realms created before this was the default would reject the
   * SDK /auth/signin password flow with "Client not allowed for direct access
   * grants". Returns true if the client now allows it. Best-effort.
   */
  /** Realms whose anon client is known to carry the auth_time mapper in this process. */
  private readonly authTimeMapped = new Set<string>();

  /**
   * Ensure a realm client puts `auth_time` in its access tokens. Realms created before
   * AUTH_TIME_MAPPER was part of createClients get it here, on their first sign-in.
   * Best-effort and cached per process: a failure only means the claim is still missing, never
   * a failed sign-in.
   *
   * Limit: Keycloak (24 and 26 alike) writes the AUTH_TIME session note only when a browser
   * sign-in completes, so tokens from the SDK's password grant still carry no auth_time
   * (test/keycloak-compat.test.mjs).
   */
  async ensureRealmClientAuthTimeMapper(realmName: string, clientId: string): Promise<void> {
    const key = `${realmName}/${clientId}`;
    if (this.authTimeMapped.has(key)) return;
    try {
      await this.ensureAuth();
      const clients = await this.client.clients.find({ realm: realmName, clientId });
      const c = clients[0];
      if (!c?.id) return;
      const mappers = await this.client.clients.listProtocolMappers({ realm: realmName, id: c.id });
      if (!mappers.some((m) => m.name === AUTH_TIME_MAPPER.name)) {
        await this.client.clients.addProtocolMapper({ realm: realmName, id: c.id }, AUTH_TIME_MAPPER);
        this.logger.log(`Added auth_time mapper to "${clientId}" in realm "${realmName}"`);
      }
      this.authTimeMapped.add(key);
    } catch (err: any) {
      this.logger.warn(
        `Could not ensure auth_time mapper for "${clientId}" in "${realmName}": ${err?.message ?? err}`,
      );
    }
  }

  async ensureRealmClientDirectGrant(realmName: string, clientId: string): Promise<boolean> {
    await this.ensureAuth();
    try {
      const clients = await this.client.clients.find({ realm: realmName, clientId });
      const c = clients[0];
      if (!c?.id) return false;
      if (c.directAccessGrantsEnabled) return true;
      await this.client.clients.update(
        { realm: realmName, id: c.id },
        { directAccessGrantsEnabled: true },
      );
      this.logger.log(`Enabled direct access grants on "${clientId}" in realm "${realmName}"`);
      return true;
    } catch (err: any) {
      this.logger.warn(
        `Could not enable direct access grants for "${clientId}" in "${realmName}": ${err?.message ?? err}`,
      );
      return false;
    }
  }

  async resetUserPasswordInRealm(
    realm: string,
    keycloakUserId: string,
    newPassword: string,
  ): Promise<void> {
    await this.ensureAuth();
    await this.client.users.resetPassword({
      realm,
      id: keycloakUserId,
      credential: { type: 'password', value: newPassword, temporary: false },
    });
    this.logger.log(`Password reset for user ${keycloakUserId} in realm "${realm}"`);
  }

  /**
   * Keycloak 24's declarative User Profile rejects attributes that aren't
   * declared, unless the realm opts in to unmanaged attributes. Phone is stored
   * as a custom attribute, so enable `unmanagedAttributePolicy=ADMIN_EDIT`
   * (idempotent) before writing it — otherwise the user update fails with a 400.
   */
  async ensureUnmanagedAttributes(realmName: string): Promise<void> {
    try {
      const baseUrl = this.config.get<string>('keycloak.url');
      const adminToken = await this.getAdminAccessToken();
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
      const url = `${baseUrl}/admin/realms/${realmName}/users/profile`;
      const { data: profile } = await axios.get(url, { headers });
      if (profile?.unmanagedAttributePolicy) return; // already enabled
      await axios.put(url, { ...profile, unmanagedAttributePolicy: 'ADMIN_EDIT' }, { headers });
      this.logger.log(`Enabled unmanaged attributes (ADMIN_EDIT) for realm "${realmName}"`);
    } catch (err: any) {
      // Non-fatal: the update below will surface a clear error if attributes are rejected.
      this.logger.warn(
        `Could not ensure unmanaged attributes for "${realmName}": ${err?.response?.status ?? err?.message}`,
      );
    }
  }

  /**
   * We sync username to the new email on email change (so email-based signin keeps
   * working). If the realm has `editUsernameAllowed=false` (Keycloak's default),
   * that update is rejected with `error-user-attribute-read-only`. Enable it
   * (idempotent) so the sync succeeds.
   */
  private async ensureEditUsername(realmName: string): Promise<void> {
    try {
      const baseUrl = this.config.get<string>('keycloak.url');
      const adminToken = await this.getAdminAccessToken();
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
      const url = `${baseUrl}/admin/realms/${realmName}`;
      const { data: realm } = await axios.get(url, { headers });
      if (realm?.editUsernameAllowed) return; // already enabled
      // Partial update only — round-tripping the full realm representation is
      // rejected by Keycloak (400). Keycloak merges the provided fields.
      await axios.put(url, { realm: realmName, editUsernameAllowed: true }, { headers });
      this.logger.log(`Enabled editUsernameAllowed for realm "${realmName}"`);
    } catch (err: any) {
      this.logger.warn(
        `Could not enable editUsernameAllowed for "${realmName}": ${err?.response?.status ?? err?.message}`,
      );
    }
  }

  async updateRealmUser(
    realmName: string,
    userId: string,
    data: {
      firstName?: string;
      lastName?: string;
      email?: string;
      enabled?: boolean;
      phoneNumber?: string;
      phoneVerified?: boolean;
      /** With a new email: whether it counts as confirmed (the dashboard's default, true). */
      emailVerified?: boolean;
    },
  ) {
    await this.ensureAuth();
    // Changing email syncs username → needs editUsernameAllowed on the realm.
    if (data.email !== undefined) await this.ensureEditUsername(realmName);
    // Keycloak 24+ (User Profile) clears profile fields a partial update omits and then
    // refuses the password grant ("Account is not fully set up"): start from what is there.
    const existing = await this.client.users.findOne({ realm: realmName, id: userId });
    const update: Record<string, any> = existing ? KeycloakAdminService.profileFields(existing) : {};
    if (data.firstName !== undefined) update.firstName = data.firstName;
    if (data.lastName !== undefined) update.lastName = data.lastName;
    // Sync username to the new email so SDK signin (which authenticates by email)
    // keeps working — see updateRealmUserEmail.
    if (data.email !== undefined) {
      update.email = data.email;
      update.emailVerified = data.emailVerified ?? true;
      update.username = data.email;
    } else if (data.emailVerified !== undefined) {
      update.emailVerified = data.emailVerified;
    }
    if (data.enabled !== undefined) update.enabled = data.enabled;
    // Phone is stored as a user attribute (Keycloak has no native phone field).
    if (data.phoneNumber !== undefined || data.phoneVerified !== undefined) {
      await this.ensureUnmanagedAttributes(realmName);
      const attrs: Record<string, any> = { ...(existing?.attributes || {}) };
      if (data.phoneNumber !== undefined) attrs.phoneNumber = data.phoneNumber ? [data.phoneNumber] : [];
      if (data.phoneVerified !== undefined) attrs.phoneVerified = [String(!!data.phoneVerified)];
      update.attributes = attrs;
    }
    try {
      await this.client.users.update({ realm: realmName, id: userId }, update);
    } catch (err: any) {
      const status = err?.response?.status ?? err?.responseData?.status ?? err?.status;
      const body = err?.response?.data;
      const message =
        body?.errorMessage || body?.error || err?.message || 'Failed to update user';
      this.logger.error(
        `updateRealmUser failed (realm="${realmName}", user=${userId}, status=${status}): ${
          body ? JSON.stringify(body) : message
        }`,
      );
      if (status === 409) {
        throw new ConflictException('That email or username is already in use');
      }
      if (status === 400) {
        throw new BadRequestException(message);
      }
      throw err;
    }
    this.logger.log(`User ${userId} updated in realm "${realmName}"`);
  }

  async updateRealmUserEmail(realmName: string, userId: string, newEmail: string) {
    await this.ensureAuth();
    // Keep username in sync with email. SDK signin authenticates by email, and
    // Keycloak's password grant resolves the literal username — so a username
    // left at the old email makes the user unable to sign in with their new one.
    await this.client.users.update(
      { realm: realmName, id: userId },
      { username: newEmail, email: newEmail, emailVerified: true },
    );
    this.logger.log(`Email changed for user ${userId} in realm "${realmName}" to "${newEmail}"`);
  }

  // ── Anonymous end users ──

  /** Marks a throw-away identity created by anonymous sign-in. */
  private static readonly ANONYMOUS_ATTRIBUTE = 'is_anonymous';

  /**
   * Copies the attribute into the tokens of the realm's anon client as the
   * boolean claim `is_anonymous`, so row-level policies can read it through
   * `auth.jwt()`. Omitted when the attribute is absent, so other users' tokens
   * do not change.
   */
  private static readonly ANONYMOUS_CLAIM_MAPPER = {
    name: 'is_anonymous',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    config: {
      'user.attribute': 'is_anonymous',
      'claim.name': 'is_anonymous',
      'jsonType.label': 'boolean',
      'id.token.claim': 'true',
      'access.token.claim': 'true',
      'userinfo.token.claim': 'true',
      multivalued: 'false',
      'aggregate.attrs': 'false',
    },
  };

  /** Realms whose anon client is known to carry the is_anonymous mapper in this process. */
  private readonly anonymousClaimMapped = new Set<string>();

  isAnonymousUser(user: { attributes?: Record<string, unknown> } | null | undefined): boolean {
    const value = (user?.attributes as any)?.[KeycloakAdminService.ANONYMOUS_ATTRIBUTE];
    return Array.isArray(value) ? value[0] === 'true' : value === 'true' || value === true;
  }

  /** Idempotent and cached per process, like the auth_time mapper. */
  async ensureRealmClientAnonymousClaimMapper(realmName: string, clientId: string): Promise<void> {
    const key = `${realmName}/${clientId}`;
    if (this.anonymousClaimMapped.has(key)) return;
    await this.ensureAuth();
    const clients = await this.client.clients.find({ realm: realmName, clientId });
    const c = clients[0];
    if (!c?.id) {
      throw new BadRequestException(`Client "${clientId}" does not exist in realm "${realmName}"`);
    }
    const mappers = await this.client.clients.listProtocolMappers({ realm: realmName, id: c.id });
    const mapper = KeycloakAdminService.ANONYMOUS_CLAIM_MAPPER;
    if (!mappers.some((m) => m.name === mapper.name)) {
      await this.client.clients.addProtocolMapper({ realm: realmName, id: c.id }, mapper);
      this.logger.log(`Added is_anonymous mapper to "${clientId}" in realm "${realmName}"`);
    }
    this.anonymousClaimMapped.add(key);
  }

  /**
   * A user that exists only to hold a session. Keycloak 24's User Profile
   * requires a name and an email even here (a missing one re-triggers profile
   * verification on every grant, which fails the password grant), so the user
   * gets placeholders: a name that says what it is and an address under the
   * reserved `.invalid` domain that can never receive mail.
   */
  async createAnonymousUser(realmName: string, username: string, password: string): Promise<string> {
    await this.ensureAuth();
    await this.ensureUnmanagedAttributes(realmName);
    const { id } = await this.client.users.create({
      realm: realmName,
      username,
      email: `${username}@anonymous.invalid`,
      firstName: 'Anonymous',
      lastName: 'User',
      enabled: true,
      emailVerified: false,
      requiredActions: [],
      attributes: {
        [KeycloakAdminService.ANONYMOUS_ATTRIBUTE]: ['true'],
        anon_created_at: [new Date().toISOString()],
      },
      credentials: [{ type: 'password', value: password, temporary: false }],
    });
    this.logger.log(`Anonymous user "${username}" created in realm "${realmName}" (${id})`);
    return id;
  }

  /**
   * Turn an anonymous user into an ordinary account in place: same Keycloak id,
   * so everything keyed on `auth.uid()` follows the person. Username tracks the
   * email as elsewhere (the password grant resolves the literal username).
   */
  async convertAnonymousUser(
    realmName: string,
    userId: string,
    data: {
      email: string;
      password: string;
      firstName?: string;
      lastName?: string;
      emailVerified: boolean;
    },
  ): Promise<void> {
    await this.ensureAuth();
    await this.ensureEditUsername(realmName);
    const current = await this.client.users.findOne({ realm: realmName, id: userId });
    if (!current?.id) throw new BadRequestException('Anonymous user not found');
    if (!this.isAnonymousUser(current)) {
      throw new BadRequestException('This user is not anonymous');
    }

    const attributes: Record<string, unknown> = { ...(current.attributes || {}) };
    delete attributes[KeycloakAdminService.ANONYMOUS_ATTRIBUTE];
    delete attributes.anon_created_at;
    const local = data.email.split('@')[0] || 'user';

    try {
      await this.client.users.update(
        { realm: realmName, id: userId },
        {
          username: data.email,
          email: data.email,
          emailVerified: data.emailVerified,
          firstName: data.firstName?.trim() || local,
          lastName: data.lastName?.trim() || local,
          attributes,
          requiredActions: [],
        },
      );
    } catch (err: any) {
      const status = err?.response?.status ?? err?.responseData?.status ?? err?.status;
      if (status === 409) throw new ConflictException('That email is already in use');
      throw err;
    }
    await this.client.users.resetPassword({
      realm: realmName,
      id: userId,
      credential: { type: 'password', value: data.password, temporary: false },
    });
    this.logger.log(`Anonymous user ${userId} in realm "${realmName}" converted to "${data.email}"`);
  }

  /**
   * Delete anonymous users older than the cutoff. A session that old has outlived
   * its refresh token (the realm's SSO idle timeout is 30 days), so nothing can
   * reach the account any more. One page per call; run again for more.
   */
  async purgeAnonymousUsers(
    realmName: string,
    olderThanDays = 30,
    max = 500,
    dryRun = false,
  ): Promise<{ matched: number; deleted: number }> {
    await this.ensureAuth();
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const users = await this.client.users.find({
      realm: realmName,
      q: `${KeycloakAdminService.ANONYMOUS_ATTRIBUTE}:true`,
      max,
      briefRepresentation: false,
    } as any);
    const stale = users.filter(
      (u) => u.id && this.isAnonymousUser(u) && (u.createdTimestamp ?? 0) < cutoff,
    );
    let deleted = 0;
    if (!dryRun) {
      for (const u of stale) {
        try {
          await this.client.users.del({ realm: realmName, id: u.id! });
          deleted++;
        } catch (err: any) {
          this.logger.warn(`Could not delete anonymous user ${u.id}: ${err?.message ?? err}`);
        }
      }
      this.logger.log(`Purged ${deleted}/${stale.length} anonymous users from realm "${realmName}"`);
    }
    return { matched: stale.length, deleted };
  }

  /** Whether the user owns an authenticator enrolled through Keycloak itself (hosted login). */
  async userHasOtpCredential(realmName: string, userId: string): Promise<boolean> {
    await this.ensureAuth();
    const creds = await this.client.users.getCredentials({ realm: realmName, id: userId });
    return (creds || []).some((c: any) => c.type === 'otp');
  }

  async userHasPasswordCredential(realmName: string, userId: string): Promise<boolean> {
    await this.ensureAuth();
    const creds = await this.client.users.getCredentials({ realm: realmName, id: userId });
    return (creds || []).some((c: any) => c.type === 'password');
  }

  /** Whether the realm's brute-force detection has the user locked out right now. */
  async isUserLockedOut(realmName: string, userId: string): Promise<boolean> {
    await this.ensureAuth();
    const status = await this.client.attackDetection.findOne({ realm: realmName, id: userId });
    return status?.disabled === true;
  }

  /**
   * Create users with the ids they already carry elsewhere.
   *
   * The ordinary create endpoint always mints a new id, while an imported
   * project's rows, foreign keys and policies all name the old one — a user
   * created that way signs in as a stranger to their own data. The realm's
   * partial import keeps the id it is given. A user that already exists (same
   * username or email) is skipped, never overwritten, and its result carries
   * the id it actually has, so the caller can tell a kept identity from a clash.
   *
   * No credentials are written: the source's password hashes are in a format
   * Keycloak cannot verify, and wait in ImportedPasswordHash instead.
   */
  async importRealmUsers(
    realmName: string,
    users: ImportedRealmUser[],
  ): Promise<ImportedRealmUserResult[]> {
    await this.ensureAuth();
    // The metadata attributes are what the GoTrue claim mappers copy into tokens; the realm
    // must accept custom attributes before the import writes them.
    if (users.some((u) => u.attributes && Object.keys(u.attributes).length > 0)) {
      await this.ensureUnmanagedAttributes(realmName);
    }
    const res = await this.client.realms.partialImport({
      realm: realmName,
      rep: { ifResourceExists: 'SKIP', users: users.map((u) => ({ ...u, requiredActions: [] })) },
    });
    return (res?.results ?? [])
      .filter((r) => r.resourceType === 'USER')
      .map((r) => ({
        action: r.action === 'ADDED' ? 'ADDED' : 'SKIPPED',
        username: r.resourceName,
        id: r.id,
      }));
  }

  // ── Platform user operations ──

  async createPlatformUser(data: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    username?: string; // kept for callers that pass email as username; ignored
  }): Promise<string> {
    await this.ensureAuth();

    const { id } = await this.client.users.create({
      realm: 'master',
      username: data.email,
      email: data.email,
      // Keycloak 24's User Profile requires firstName/lastName; empty values make
      // the password grant fail with "Account is not fully set up". Fall back to
      // the email local part so the account is always login-ready.
      firstName: data.firstName?.trim() || data.email.split('@')[0] || 'user',
      lastName: data.lastName?.trim() || data.email.split('@')[0] || 'user',
      enabled: true,
      emailVerified: true,
      credentials: [
        { type: 'password', value: data.password, temporary: false },
      ],
    });

    this.logger.log(`Platform user "${data.email}" created (${id})`);
    return id;
  }

  /** Fetch a master-realm user by id (null if missing). */
  async getPlatformUserById(userId: string) {
    await this.ensureAuth();
    const u = await this.client.users
      .findOne({ realm: 'master', id: userId })
      .catch(() => null);
    return u ?? null;
  }

  /** Delete a platform (master realm) user — used to roll back a half-finished signup. */
  async deletePlatformUser(userId: string): Promise<void> {
    await this.ensureAuth();
    await this.client.users.del({ realm: 'master', id: userId });
    this.logger.log(`Platform user "${userId}" deleted`);
  }

  async findPlatformUserByEmail(email: string) {
    await this.ensureAuth();
    const norm = (email || '').trim().toLowerCase();
    // `exact: true` on email has been observed to miss existing users in the
    // master realm (returns 0 while a broad search finds them). Fall back to a
    // non-exact search and a free-text search, matching case-insensitively.
    // This backs the signup duplicate-email guard — a miss here makes
    // users.create fail with a cryptic 409 ("Network response was not OK").
    let users = await this.client.users.find({ realm: 'master', email, exact: true });
    if (!users.length) {
      users = await this.client.users.find({ realm: 'master', email });
    }
    if (!users.length) {
      users = await this.client.users.find({ realm: 'master', search: email });
    }
    return (
      users.find((u) => (u.email || '').trim().toLowerCase() === norm) ||
      null
    );
  }

  async findPlatformUserByUsername(username: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({ realm: 'master', username, exact: true });
    return users[0] || null;
  }

  async updatePlatformUserEmail(keycloakUserId: string, email: string) {
    await this.ensureAuth();
    await this.client.users.update(
      { realm: 'master', id: keycloakUserId },
      { email, emailVerified: true },
    );
    this.logger.log(`Updated email for Keycloak user ${keycloakUserId} to ${email}`);
  }

  async resetPlatformUserPassword(
    userId: string,
    newPassword: string,
    email?: string,
  ): Promise<void> {
    await this.ensureAuth();
    const resolvedId = await this.resolvePlatformUserId(userId, email);
    await this.client.users.resetPassword({
      realm: 'master',
      id: resolvedId,
      credential: { type: 'password', value: newPassword, temporary: false },
    });
    this.logger.log(`Password reset for platform user ${resolvedId}`);
  }

  async resetPlatformUserPasswordWithPolicy(
    keycloakUserId: string,
    newPassword: string,
    forceChangeOnFirstLogin: boolean,
  ): Promise<void> {
    await this.ensureAuth();
    const existing = await this.client.users.findOne({
      realm: 'master',
      id: keycloakUserId,
    });
    const attributes = {
      ...(existing?.attributes || {}),
      kb_force_password_change: [forceChangeOnFirstLogin ? 'true' : 'false'],
    };
    // Add or remove UPDATE_PASSWORD only; another pending action (a required
    // authenticator setup, for instance) must survive a password reset.
    const others = ((existing?.requiredActions as string[]) || []).filter((a) => a !== 'UPDATE_PASSWORD');
    const requiredActions = forceChangeOnFirstLogin ? [...others, 'UPDATE_PASSWORD'] : others;
    await this.client.users.update(
      { realm: 'master', id: keycloakUserId },
      { attributes, requiredActions },
    );
    await this.client.users.resetPassword({
      realm: 'master',
      id: keycloakUserId,
      credential: {
        type: 'password',
        value: newPassword,
        temporary: false,
      },
    });
    // Clear any Keycloak brute-force lock so the new password works on the very
    // next login. Without this, prior failed attempts keep the account locked
    // at the Keycloak level and the password grant returns invalid_grant — which
    // surfaces to the user as "Email or password is incorrect" even though the
    // password is correct.
    await this.clearBruteForceLock(keycloakUserId);

    this.logger.log(
      `Password reset for platform user ${keycloakUserId} (forceChangeOnFirstLogin=${forceChangeOnFirstLogin})`,
    );
  }

  /**
   * Clear Keycloak's own brute-force detection lock for a platform user.
   * Best-effort: a no-op if brute-force is disabled or the user has no lock.
   */
  async clearBruteForceLock(keycloakUserId: string): Promise<void> {
    await this.ensureAuth();
    try {
      await this.client.attackDetection.del({ realm: 'master', id: keycloakUserId });
      this.logger.log(`Cleared Keycloak brute-force lock for ${keycloakUserId}`);
    } catch (err: any) {
      this.logger.warn(
        `Could not clear brute-force lock for ${keycloakUserId}: ${err?.message ?? err}`,
      );
    }
  }

  async getPlatformUserForcePasswordChangeByEmail(email: string): Promise<boolean> {
    await this.ensureAuth();
    const user = await this.findPlatformUserByEmail(email);
    if (!user?.id) return false;
    const fullUser = await this.client.users.findOne({ realm: 'master', id: user.id });
    return fullUser?.attributes?.kb_force_password_change?.[0] === 'true';
  }

  async clearPlatformUserForcePasswordChange(userId: string, email?: string): Promise<void> {
    await this.ensureAuth();
    const resolvedId = await this.resolvePlatformUserId(userId, email);
    const existing = await this.client.users.findOne({ realm: 'master', id: resolvedId });
    const attributes = {
      ...(existing?.attributes || {}),
      kb_force_password_change: ['false'],
    };
    // Clear the custom attribute and the UPDATE_PASSWORD action only; other
    // pending actions (a required authenticator setup) are left in place.
    const requiredActions = ((existing?.requiredActions as string[]) || []).filter(
      (a) => a !== 'UPDATE_PASSWORD',
    );
    await this.client.users.update(
      { realm: 'master', id: resolvedId },
      { attributes, requiredActions },
    );
  }

  async getPlatformUserForcePasswordChangeById(userId: string, email?: string): Promise<boolean> {
    await this.ensureAuth();
    const resolvedId = await this.resolvePlatformUserId(userId, email);
    const user = await this.client.users.findOne({ realm: 'master', id: resolvedId });
    return user?.attributes?.kb_force_password_change?.[0] === 'true';
  }

  async getPlatformUserAuthProviderById(
    userId: string,
  ): Promise<'local' | 'google' | 'github'> {
    const methods = await this.getPlatformUserSignInMethodsById(userId);
    return methods.authProvider;
  }

  /** One Keycloak user fetch + federated + credentials (used by management list + sign-in helpers). */
  private async buildPlatformSignInMethodsFromUser(
    resolvedId: string,
    user: Record<string, unknown> | null,
    adminToken: string,
  ): Promise<{
    authProvider: 'local' | 'google' | 'github';
    signOnMethod: 'local' | 'google' | 'github';
    linkedProviders: Array<'google' | 'github'>;
    hasPasswordAuth: boolean;
  }> {
    const baseUrl = this.config.get<string>('keycloak.url');
    const headers = { Authorization: `Bearer ${adminToken}` };
    const { data: federatedData } = await axios.get(
      `${baseUrl}/admin/realms/master/users/${resolvedId}/federated-identity`,
      { headers },
    );
    const providers = Array.isArray(federatedData)
      ? federatedData.map((x: any) => String(x?.identityProvider || '').toLowerCase())
      : [];
    const linkedProviders: Array<'google' | 'github'> = [];
    if (providers.includes('google')) linkedProviders.push('google');
    if (providers.includes('github')) linkedProviders.push('github');

    let hasPasswordAuth = true;
    try {
      const { data: credentials } = await axios.get(
        `${baseUrl}/admin/realms/master/users/${resolvedId}/credentials`,
        { headers },
      );
      hasPasswordAuth = Array.isArray(credentials)
        ? credentials.some((c: any) => String(c?.type || '').toLowerCase() === 'password')
        : true;
    } catch {
      hasPasswordAuth = true;
    }

    const attrs = user?.attributes as Record<string, string[]> | undefined;
    const override = String(attrs?.kb_auth_provider_override?.[0] || '').toLowerCase();
    if (override === 'google' || override === 'github' || override === 'local') {
      return {
        authProvider: override,
        signOnMethod: linkedProviders.includes('google')
          ? 'google'
          : linkedProviders.includes('github')
            ? 'github'
            : 'local',
        linkedProviders,
        hasPasswordAuth,
      };
    }

    if (linkedProviders.includes('google')) {
      return {
        authProvider: 'google',
        signOnMethod: 'google',
        linkedProviders,
        hasPasswordAuth,
      };
    }
    if (linkedProviders.includes('github')) {
      return {
        authProvider: 'github',
        signOnMethod: 'github',
        linkedProviders,
        hasPasswordAuth,
      };
    }
    return {
      authProvider: 'local',
      signOnMethod: 'local',
      linkedProviders,
      hasPasswordAuth,
    };
  }

  async getPlatformUserSignInMethodsById(
    userId: string,
    email?: string,
  ): Promise<{
    authProvider: 'local' | 'google' | 'github';
    signOnMethod: 'local' | 'google' | 'github';
    linkedProviders: Array<'google' | 'github'>;
    hasPasswordAuth: boolean;
  }> {
    await this.ensureAuth();
    const adminToken = await this.getAdminAccessToken();
    const resolvedId = await this.resolvePlatformUserId(userId, email);
    const user = await this.client.users.findOne({ realm: 'master', id: resolvedId });
    return this.buildPlatformSignInMethodsFromUser(
      resolvedId,
      user as Record<string, unknown> | null,
      adminToken,
    );
  }

  /** Single Keycloak round-trip for enabled + sign-in fields (management user rows). */
  async getPlatformUserManagementSnapshotById(
    userId: string,
    email?: string,
  ): Promise<{
    isActive: boolean;
    authProvider: 'local' | 'google' | 'github';
    signOnMethod: 'local' | 'google' | 'github';
    linkedProviders: Array<'google' | 'github'>;
    hasPasswordAuth: boolean;
  }> {
    await this.ensureAuth();
    const adminToken = await this.getAdminAccessToken();
    const resolvedId = await this.resolvePlatformUserId(userId, email);
    const user = await this.client.users.findOne({ realm: 'master', id: resolvedId });
    const isActive = (user as { enabled?: boolean } | undefined)?.enabled !== false;
    const methods = await this.buildPlatformSignInMethodsFromUser(
      resolvedId,
      user as Record<string, unknown> | null,
      adminToken,
    );
    return { isActive, ...methods };
  }

  async setPlatformUserAuthProviderOverrideById(
    userId: string,
    email: string | undefined,
    provider: 'local' | 'google' | 'github',
  ): Promise<void> {
    await this.ensureAuth();
    const resolvedId = await this.resolvePlatformUserId(userId, email);
    const existing = await this.client.users.findOne({ realm: 'master', id: resolvedId });
    const attributes = {
      ...(existing?.attributes || {}),
      kb_auth_provider_override: [provider],
    };
    await this.client.users.update({ realm: 'master', id: resolvedId }, { attributes });
  }

  async getPlatformUserEnabledById(userId: string): Promise<boolean> {
    await this.ensureAuth();
    const user = await this.client.users.findOne({ realm: 'master', id: userId });
    return user?.enabled !== false;
  }

  async setPlatformUserEnabledById(userId: string, enabled: boolean): Promise<void> {
    await this.ensureAuth();
    await this.client.users.update({ realm: 'master', id: userId }, { enabled });
  }

  // ── Identity provider operations ──

  async upsertIdentityProvider(
    realmName: string,
    provider: SupportedIdpProvider,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ) {
    await this.ensureAuth();
    await this.ensureAutoLinkFlow(realmName);

    const alias = provider;
    const map: Record<
      SupportedIdpProvider,
      { providerId: string; scope: string; extraConfig?: Record<string, string> }
    > = {
      google: {
        providerId: 'google',
        scope: 'openid email profile',
        extraConfig: { prompt: 'select_account login', max_age: '0' },
      },
      microsoft: { providerId: 'microsoft', scope: 'openid email profile' },
      apple: { providerId: 'apple', scope: 'openid email name' },
      github: {
        providerId: 'github',
        scope: 'user:email',
        extraConfig: { prompt: 'login', max_age: '0' },
      },
      gitlab: { providerId: 'gitlab', scope: 'read_user openid profile email' },
      linkedin: { providerId: 'linkedin-openid', scope: 'openid profile email' },
      facebook: { providerId: 'facebook', scope: 'email public_profile' },
      twitter: { providerId: 'twitter', scope: 'users.read tweet.read offline.access' },
    };
    const resolved = map[provider];
    const flowAlias = KeycloakAdminService.AUTO_LINK_FLOW_ALIAS;
    const baseUrl = this.config.get<string>('keycloak.url');
    const adminToken = await this.getAdminAccessToken();
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    const idpBase = `${baseUrl}/admin/realms/${realmName}/identity-provider/instances`;

    const idpBody = {
      alias,
      providerId: resolved.providerId,
      enabled: true,
      trustEmail: true,
      firstBrokerLoginFlowAlias: flowAlias,
      config: {
        clientId,
        clientSecret,
        defaultScope: resolved.scope,
        ...(resolved.extraConfig || {}),
      },
    };

    const existing = await axios.get(`${idpBase}/${alias}`, { headers }).catch(() => null);
    if (existing?.data) {
      await axios.put(`${idpBase}/${alias}`, idpBody, { headers });
      this.logger.log(`Updated ${provider} IdP in realm "${realmName}"`);
    } else {
      await axios.post(idpBase, idpBody, { headers });
      this.logger.log(`Created ${provider} IdP in realm "${realmName}"`);
    }
  }

  async deleteIdentityProvider(realmName: string, provider: SupportedIdpProvider) {
    await this.ensureAuth();
    try {
      await this.client.identityProviders.del({ realm: realmName, alias: provider });
      this.logger.log(`Deleted ${provider} identity provider from realm "${realmName}"`);
    } catch {
      // not found is fine
    }
  }

  async listIdentityProviders(realmName: string) {
    await this.ensureAuth();
    const providers = await this.client.identityProviders.find({ realm: realmName });
    return providers.map((p: any) => ({
      alias: p.alias,
      providerId: p.providerId,
      enabled: p.enabled,
    }));
  }

  // ── Platform-realm two-factor helpers (dashboard sign-in) ──

  /** Removes one required action and leaves every other pending action alone. */
  async removeUserRequiredAction(realmName: string, userId: string, action: string): Promise<void> {
    await this.setUserRequiredAction(realmName, userId, action, false);
  }

  /** Whether `action` is pending on the user. */
  async userHasRequiredAction(realmName: string, userId: string, action: string): Promise<boolean> {
    await this.ensureAuth();
    const u = await this.client.users.findOne({ realm: realmName, id: userId });
    return ((u?.requiredActions as string[]) || []).includes(action);
  }

  /** The user's authenticator credentials (type `otp`) with their labels. */
  async getUserOtpCredentials(realmName: string, userId: string) {
    const creds = await this.getUserCredentials(realmName, userId);
    return creds.filter((c) => c.type === 'otp');
  }

  /** Keycloak username of a master-realm user, or null when the user is gone. */
  async getPlatformUsername(userId: string): Promise<string | null> {
    const u = await this.getPlatformUserById(userId);
    return (u?.username as string | undefined) ?? null;
  }

  private directGrantOtpCache: { until: number; value: boolean } | null = null;

  /**
   * Whether the master realm's direct-grant flow asks for a one-time code when
   * the user has an authenticator. Keycloak's default flow does (the
   * "Direct Grant - Conditional OTP" sub-flow); an installation that replaced
   * it with a password-only flow would let a password grant through unchecked,
   * so enrolment and the team policy are refused until the flow validates OTP.
   *
   * The flow checked is the one the dashboard's sign-in client actually runs:
   * its own direct-grant override when it has one, otherwise the realm's
   * binding. Read-only: the realm is never modified here. Cached for ten
   * minutes; a failed inspection is cached for thirty seconds and reads as
   * "no", so nothing is promised that cannot be checked.
   */
  async directGrantValidatesOtp(): Promise<boolean> {
    const now = Date.now();
    if (this.directGrantOtpCache && now < this.directGrantOtpCache.until) {
      return this.directGrantOtpCache.value;
    }
    let value = false;
    let ttl = 10 * 60 * 1000;
    try {
      await this.ensureAuth();
      const realm = await this.client.realms.findOne({ realm: 'master' });
      const flows = (await this.client.authenticationManagement.getFlows({ realm: 'master' })) || [];
      const signInClientId = this.config.get<string>('keycloak.adminClientId') || 'admin-cli';
      const [signInClient] = await this.client.clients.find({ realm: 'master', clientId: signInClientId });
      const overrideId = (signInClient?.authenticationFlowBindingOverrides as Record<string, string> | undefined)
        ?.direct_grant;
      const flow = overrideId
        ? flows.find((f: any) => f.id === overrideId)
        : flows.find((f: any) => f.alias === ((realm?.directGrantFlow as string | undefined) || 'direct grant'));
      if (flow?.alias) {
        const executions = await this.client.authenticationManagement.getExecutions({
          realm: 'master',
          flow: flow.alias,
        });
        value = KeycloakAdminService.executionsValidateOtp((executions || []) as any[]);
      }
    } catch (err: any) {
      this.logger.warn(`Could not inspect the direct-grant flow: ${err?.message ?? err}`);
      value = false;
      ttl = 30 * 1000;
    }
    this.directGrantOtpCache = { until: now + ttl, value };
    return value;
  }

  /**
   * Reads Keycloak's flattened, depth-first execution list: true when the
   * direct-grant OTP authenticator is REQUIRED and every sub-flow above it is
   * REQUIRED or CONDITIONAL (the default "Direct Grant - Conditional OTP"
   * shape). An OTP step that is disabled, alternative, or under a disabled or
   * alternative sub-flow can be skipped, so it does not count.
   */
  static executionsValidateOtp(
    executions: Array<{ providerId?: string; requirement?: string; level?: number; authenticationFlow?: boolean }>,
  ): boolean {
    const parents: Array<{ level: number; requirement: string }> = [];
    for (const e of executions) {
      const level = e.level ?? 0;
      while (parents.length && parents[parents.length - 1].level >= level) parents.pop();
      if (e.authenticationFlow) {
        parents.push({ level, requirement: String(e.requirement || '') });
        continue;
      }
      if (
        e.providerId === 'direct-grant-validate-otp' &&
        e.requirement === 'REQUIRED' &&
        parents.every((p) => p.requirement === 'REQUIRED' || p.requirement === 'CONDITIONAL')
      ) {
        return true;
      }
    }
    return false;
  }
}
