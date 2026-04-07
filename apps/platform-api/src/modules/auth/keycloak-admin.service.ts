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

@Injectable()
export class KeycloakAdminService implements OnModuleInit {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private client!: KcAdminClient;

  constructor(private readonly config: ConfigService) {}

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

  private generateUsername(firstName?: string, lastName?: string, email?: string): string {
    let base: string;
    if (firstName || lastName) {
      base = `${firstName || ''}${lastName || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    } else {
      base = (email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    if (!base) base = 'user';
    const suffix = Math.random().toString(36).substring(2, 7);
    return `${base}${suffix}`;
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

      const existing = await this.client.clients.find({ realm: 'master', clientId });
      if (existing.length > 0) {
        await this.client.clients.update(
          { realm: 'master', id: existing[0].id! },
          {
            clientId,
            publicClient: true,
            standardFlowEnabled: true,
            directAccessGrantsEnabled: false,
            redirectUris: [callbackUrl],
            webOrigins: [appUrl, publicApiUrl, '+'],
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
          redirectUris: [callbackUrl],
          webOrigins: [appUrl, publicApiUrl, '+'],
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
        // Force Google account picker on every login so users can
        // choose which Gmail account to use after sign-out.
        extraConfig: { prompt: 'select_account' },
      },
      {
        alias: 'github',
        providerId: 'github',
        envId: 'oauth.githubClientId',
        envSecret: 'oauth.githubClientSecret',
        scope: 'user:email',
        extraConfig: {},
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
      await this.authenticate();
    } catch (err) {
      this.logger.error('Failed to re-authenticate with Keycloak', err);
      throw new InternalServerErrorException('Keycloak authentication failed');
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
    }
    await this.client.realms.create({
      realm: realmName,
      enabled: true,
      registrationAllowed: true,
      loginWithEmailAllowed: true,
      duplicateEmailsAllowed: false,
      verifyEmail: false,
      accessTokenLifespan: 1800,
      ssoSessionIdleTimeout: 86400,
    });

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

    await this.client.clients.create({
      realm: realmName,
      clientId: anonClientId,
      enabled: true,
      publicClient: true,
      directAccessGrantsEnabled: true,
      standardFlowEnabled: true,
    });

    const serviceSecret = uuid();
    await this.client.clients.create({
      realm: realmName,
      clientId: serviceClientId,
      enabled: true,
      publicClient: false,
      serviceAccountsEnabled: true,
      directAccessGrantsEnabled: true,
      secret: serviceSecret,
    });

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
    const users = await this.client.users.find({ realm: realmName });
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: u.enabled,
      createdTimestamp: u.createdTimestamp,
    }));
  }

  async createUser(
    realmName: string,
    data: { username?: string; email: string; password: string; firstName?: string; lastName?: string },
  ) {
    await this.ensureAuth();
    const username = data.username || this.generateUsername(data.firstName, data.lastName, data.email);

    await this.client.users.create({
      realm: realmName,
      username,
      email: data.email,
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      enabled: true,
      emailVerified: true,
      credentials: [
        { type: 'password', value: data.password, temporary: false },
      ],
    });

    this.logger.log(`User "${username}" created in realm "${realmName}"`);
    return { message: `User created in realm` };
  }

  async createProjectUser(
    realmName: string,
    data: { email: string; password: string; firstName?: string; lastName?: string },
  ): Promise<string> {
    await this.ensureAuth();
    const username = this.generateUsername(data.firstName, data.lastName, data.email);

    const { id } = await this.client.users.create({
      realm: realmName,
      username,
      email: data.email,
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      enabled: true,
      emailVerified: false,
      requiredActions: [],
      credentials: [
        { type: 'password', value: data.password, temporary: false },
      ],
    });

    this.logger.log(`Project user "${username}" created in realm "${realmName}" (${id})`);
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
      createdTimestamp: user.createdTimestamp,
    };
  }

  async findUserInRealm(realmName: string, email: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({ realm: realmName, email, exact: true });
    return users[0] || null;
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

  async resetRealmUserPassword(realmName: string, userId: string, newPassword: string) {
    await this.ensureAuth();
    await this.client.users.resetPassword({
      realm: realmName,
      id: userId,
      credential: { type: 'password', value: newPassword, temporary: false },
    });
    this.logger.log(`Password reset for user ${userId} in realm "${realmName}"`);
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
    data: { firstName?: string; lastName?: string; email?: string; enabled?: boolean },
  ) {
    await this.ensureAuth();
    const update: Record<string, any> = {};
    if (data.firstName !== undefined) update.firstName = data.firstName;
    if (data.lastName !== undefined) update.lastName = data.lastName;
    if (data.email !== undefined) { update.email = data.email; update.emailVerified = true; }
    if (data.enabled !== undefined) update.enabled = data.enabled;
    await this.client.users.update({ realm: realmName, id: userId }, update);
    this.logger.log(`User ${userId} updated in realm "${realmName}"`);
  }

  async updateRealmUserEmail(realmName: string, userId: string, newEmail: string) {
    await this.ensureAuth();
    await this.client.users.update(
      { realm: realmName, id: userId },
      { email: newEmail, emailVerified: true },
    );
    this.logger.log(`Email changed for user ${userId} in realm "${realmName}" to "${newEmail}"`);
  }

  // ── Platform user operations ──

  async createPlatformUser(data: {
    username: string;
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }): Promise<string> {
    await this.ensureAuth();

    const { id } = await this.client.users.create({
      realm: 'master',
      username: data.username,
      email: data.email,
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      enabled: true,
      emailVerified: true,
      credentials: [
        { type: 'password', value: data.password, temporary: false },
      ],
    });

    this.logger.log(`Platform user "${data.username}" created (${id})`);
    return id;
  }

  async findPlatformUserByUsername(username: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({ realm: 'master', username, exact: true });
    return users[0] || null;
  }

  async findPlatformUserByEmail(email: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({ realm: 'master', email, exact: true });
    return users[0] || null;
  }

  async resetPlatformUserPassword(keycloakUserId: string, newPassword: string): Promise<void> {
    await this.ensureAuth();
    await this.client.users.resetPassword({
      realm: 'master',
      id: keycloakUserId,
      credential: { type: 'password', value: newPassword, temporary: false },
    });
    this.logger.log(`Password reset for platform user ${keycloakUserId}`);
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
    await this.client.users.update(
      { realm: 'master', id: keycloakUserId },
      { attributes, requiredActions: [] },
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
    this.logger.log(
      `Password reset for platform user ${keycloakUserId} (forceChangeOnFirstLogin=${forceChangeOnFirstLogin})`,
    );
  }

  async getPlatformUserForcePasswordChangeByEmail(email: string): Promise<boolean> {
    await this.ensureAuth();
    const user = await this.findPlatformUserByEmail(email);
    if (!user?.id) return false;
    const fullUser = await this.client.users.findOne({ realm: 'master', id: user.id });
    return fullUser?.attributes?.kb_force_password_change?.[0] === 'true';
  }

  async clearPlatformUserForcePasswordChange(userId: string): Promise<void> {
    await this.ensureAuth();
    const existing = await this.client.users.findOne({ realm: 'master', id: userId });
    const attributes = {
      ...(existing?.attributes || {}),
      kb_force_password_change: ['false'],
    };
    await this.client.users.update({ realm: 'master', id: userId }, { attributes });
  }

  async getPlatformUserForcePasswordChangeById(userId: string): Promise<boolean> {
    await this.ensureAuth();
    const user = await this.client.users.findOne({ realm: 'master', id: userId });
    return user?.attributes?.kb_force_password_change?.[0] === 'true';
  }

  // ── Identity provider operations ──

  async upsertIdentityProvider(
    realmName: string,
    provider: 'google' | 'github',
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ) {
    await this.ensureAuth();
    await this.ensureAutoLinkFlow(realmName);

    const alias = provider;
    const providerId = provider === 'github' ? 'github' : 'google';
    const flowAlias = KeycloakAdminService.AUTO_LINK_FLOW_ALIAS;
    const baseUrl = this.config.get<string>('keycloak.url');
    const adminToken = await this.getAdminAccessToken();
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    const idpBase = `${baseUrl}/admin/realms/${realmName}/identity-provider/instances`;

    const idpBody = {
      alias,
      providerId,
      enabled: true,
      trustEmail: true,
      firstBrokerLoginFlowAlias: flowAlias,
      config: {
        clientId,
        clientSecret,
        defaultScope: provider === 'google' ? 'openid email profile' : 'user:email',
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

  async deleteIdentityProvider(realmName: string, provider: 'google' | 'github') {
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
