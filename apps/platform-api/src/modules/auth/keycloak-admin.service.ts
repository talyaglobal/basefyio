import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import KcAdminClient from '@keycloak/keycloak-admin-client';
import { v4 as uuid } from 'uuid';
import { randomBytes } from 'crypto';
import axios from 'axios';

export interface ProjectClients {
  anonKey: string;
  serviceKey: string;
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
    await this.ensureRealmTokenLifespan();
    await this.ensureAutoLinkFlow('master');
    await this.ensurePlatformOAuthClient();
    await this.ensurePlatformIdentityProviders();
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
      const clientId = 'kolaybase-platform';
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
    return 'kolaybase-platform';
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
      }),
    );

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

    const anonKey = `kb_anon_${randomBytes(32).toString('base64url')}`;
    const serviceKey = `kb_service_${randomBytes(32).toString('base64url')}`;
    return { anonKey, serviceKey };
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
      createdTimestamp: u.createdTimestamp,
    }));
  }

  // ── Sessions / providers / lifecycle emails (Supabase-style auth dashboard) ──

  /** Active sessions for a single realm user. */
  async listUserSessions(realmName: string, userId: string) {
    await this.ensureAuth();
    const sessions = await this.client.users.listSessions({ realm: realmName, id: userId });
    return (sessions || []).map((s: any) => ({
      id: s.id,
      ipAddress: s.ipAddress ?? null,
      start: s.start ?? null,
      lastAccess: s.lastAccess ?? null,
      clients: s.clients ? Object.values(s.clients) : [],
    }));
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
    return Array.from(byId.values()).sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));
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
    data: { email: string; password: string; firstName?: string; lastName?: string },
  ): Promise<string> {
    await this.ensureAuth();

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
      // Mark verified so a realm with "Verify Email" on doesn't block the
      // password grant (the app runs its own email verification when needed).
      emailVerified: true,
      requiredActions: [],
      credentials: [
        { type: 'password', value: data.password, temporary: false },
      ],
    });

    this.logger.log(`Project user "${data.email}" created in realm "${realmName}" (${id})`);
    return id;
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
    const update: Record<string, unknown> = { emailVerified: true, requiredActions: [] };
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
    },
  ) {
    await this.ensureAuth();
    const update: Record<string, any> = {};
    if (data.firstName !== undefined) update.firstName = data.firstName;
    if (data.lastName !== undefined) update.lastName = data.lastName;
    // Sync username to the new email so SDK signin (which authenticates by email)
    // keeps working — see updateRealmUserEmail.
    if (data.email !== undefined) { update.email = data.email; update.emailVerified = true; update.username = data.email; }
    if (data.enabled !== undefined) update.enabled = data.enabled;
    // Phone is stored as a user attribute (Keycloak has no native phone field).
    if (data.phoneNumber !== undefined || data.phoneVerified !== undefined) {
      const current = await this.client.users.findOne({ realm: realmName, id: userId });
      const attrs: Record<string, any> = { ...(current?.attributes || {}) };
      if (data.phoneNumber !== undefined) attrs.phoneNumber = data.phoneNumber ? [data.phoneNumber] : [];
      if (data.phoneVerified !== undefined) attrs.phoneVerified = [String(!!data.phoneVerified)];
      update.attributes = attrs;
    }
    await this.client.users.update({ realm: realmName, id: userId }, update);
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
    // If forceChangeOnFirstLogin is true, add UPDATE_PASSWORD to requiredActions
    const requiredActions = forceChangeOnFirstLogin ? ['UPDATE_PASSWORD'] : [];
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
    // Clear both the custom attribute and Keycloak's requiredActions
    await this.client.users.update(
      { realm: 'master', id: resolvedId },
      { attributes, requiredActions: [] },
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
}
