import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import KcAdminClient from '@keycloak/keycloak-admin-client';
import { v4 as uuid } from 'uuid';
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
          `${authBase}/flows/${alias}/executions`,
          { headers },
        );
        const hasCreateUnique = executions.some((e: any) => e.providerId === 'idp-create-user-if-unique');
        const hasAutoLink = executions.some((e: any) => e.providerId === 'idp-auto-link');
        if (hasCreateUnique && hasAutoLink) return alias;

        this.logger.log(`Deleting broken auto-link flow in realm "${realmName}"`);
        await axios.delete(`${authBase}/flows/${existing.id}`, { headers });
      }

      await axios.post(`${authBase}/flows`, {
        alias,
        description: 'Auto-link brokered accounts to existing accounts with same email',
        providerId: 'basic-flow',
        topLevel: true,
        builtIn: false,
      }, { headers });

      await axios.post(`${authBase}/flows/${alias}/executions/execution`, {
        provider: 'idp-create-user-if-unique',
      }, { headers });

      await axios.post(`${authBase}/flows/${alias}/executions/execution`, {
        provider: 'idp-auto-link',
      }, { headers });

      const { data: executions } = await axios.get(
        `${authBase}/flows/${alias}/executions`,
        { headers },
      );
      for (const exec of executions) {
        await axios.put(`${authBase}/flows/${alias}/executions`, {
          ...exec,
          requirement: 'ALTERNATIVE',
        }, { headers });
      }

      this.logger.log(`Auto-link broker flow created for realm "${realmName}"`);
    } catch (err: any) {
      this.logger.warn(`Could not ensure auto-link flow for "${realmName}": ${err.message}`);
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
    const providers: { alias: string; providerId: string; envId: string; envSecret: string; scope: string }[] = [
      {
        alias: 'google',
        providerId: 'google',
        envId: 'platformOAuth.googleClientId',
        envSecret: 'platformOAuth.googleClientSecret',
        scope: 'openid email profile',
      },
      {
        alias: 'github',
        providerId: 'github',
        envId: 'platformOAuth.githubClientId',
        envSecret: 'platformOAuth.githubClientSecret',
        scope: 'user:email',
      },
    ];

    for (const p of providers) {
      const clientId = this.config.get<string>(p.envId);
      const clientSecret = this.config.get<string>(p.envSecret);
      if (!clientId || !clientSecret) continue;

      try {
        const existing = await this.client.identityProviders
          .findOne({ realm: 'master', alias: p.alias })
          .catch(() => null);

        const idpConfig = {
          alias: p.alias,
          providerId: p.providerId,
          enabled: true,
          trustEmail: true,
          firstBrokerLoginFlowAlias: flowAlias,
          config: { clientId, clientSecret, defaultScope: p.scope },
        };

        if (existing) {
          await this.client.identityProviders.update(
            { realm: 'master', alias: p.alias },
            idpConfig,
          );
          this.logger.log(`Platform ${p.alias} identity provider updated`);
        } else {
          await this.client.identityProviders.create({
            realm: 'master',
            ...idpConfig,
          });
          this.logger.log(`Platform ${p.alias} identity provider created`);
        }
      } catch (err: any) {
        this.logger.warn(`Could not configure platform ${p.alias} IdP: ${err.message}`);
      }
    }
  }

  getPlatformOAuthClientId(): string {
    return 'kolaybase-platform';
  }

  getEnabledPlatformProviders(): string[] {
    const result: string[] = [];
    if (this.config.get<string>('platformOAuth.googleClientId')) result.push('google');
    if (this.config.get<string>('platformOAuth.githubClientId')) result.push('github');
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

  /** Re-authenticate before each admin operation to prevent token expiry. */
  private async ensureAuth() {
    try {
      await this.authenticate();
    } catch (err) {
      this.logger.error('Failed to re-authenticate with Keycloak', err);
      throw new InternalServerErrorException(
        'Keycloak authentication failed',
      );
    }
  }

  async createRealm(realmName: string): Promise<void> {
    await this.ensureAuth();

    await this.client.realms.create({
      realm: realmName,
      enabled: true,
      registrationAllowed: true,
      loginWithEmailAllowed: true,
      duplicateEmailsAllowed: false,
      accessTokenLifespan: 1800,
      ssoSessionIdleTimeout: 86400,
    });

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

    return {
      anonKey: anonClientId,
      serviceKey: `${serviceClientId}:${serviceSecret}`,
    };
  }

  async deleteRealm(realmName: string): Promise<void> {
    await this.ensureAuth();
    await this.client.realms.del({ realm: realmName });
    this.logger.log(`Realm "${realmName}" deleted`);
  }

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
    data: { email: string; password: string; firstName?: string; lastName?: string },
  ) {
    await this.ensureAuth();

    const username = this.generateUsername(data.firstName, data.lastName, data.email);

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

  async deleteUser(realmName: string, userId: string) {
    await this.ensureAuth();
    await this.client.users.del({ realm: realmName, id: userId });
    this.logger.log(`User "${userId}" deleted from realm "${realmName}"`);
    return { message: 'User deleted' };
  }

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
    const users = await this.client.users.find({
      realm: 'master',
      username,
      exact: true,
    });
    return users[0] || null;
  }

  async resetPlatformUserPassword(userId: string, newPassword: string) {
    await this.ensureAuth();
    await this.client.users.resetPassword({
      realm: 'master',
      id: userId,
      credential: { type: 'password', value: newPassword, temporary: false },
    });
    this.logger.log(`Password reset for platform user ${userId}`);
  }

  async findPlatformUserByEmail(email: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({
      realm: 'master',
      email,
      exact: true,
    });
    return users[0] || null;
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
      credentials: [
        { type: 'password', value: data.password, temporary: false },
      ],
    });

    this.logger.log(`Project user "${username}" created in realm "${realmName}" (${id})`);
    return id;
  }

  async findUserInRealm(realmName: string, email: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({
      realm: realmName,
      email,
      exact: true,
    });
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

  async updateRealmUserEmail(realmName: string, userId: string, newEmail: string) {
    await this.ensureAuth();
    await this.client.users.update(
      { realm: realmName, id: userId },
      { email: newEmail, emailVerified: true },
    );
    this.logger.log(`Email changed for user ${userId} in realm "${realmName}" to "${newEmail}"`);
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

    const existing = await this.client.identityProviders.findOne({ realm: realmName, alias })
      .catch(() => null);

    const config: Record<string, string> = {
      clientId,
      clientSecret,
      defaultScope: provider === 'google' ? 'openid email profile' : 'user:email',
    };

    if (existing) {
      await this.client.identityProviders.update(
        { realm: realmName, alias },
        {
          alias,
          providerId,
          enabled: true,
          trustEmail: true,
          firstBrokerLoginFlowAlias: flowAlias,
          config,
        },
      );
      this.logger.log(`Updated ${provider} identity provider in realm "${realmName}"`);
    } else {
      await this.client.identityProviders.create({
        realm: realmName,
        alias,
        providerId,
        enabled: true,
        trustEmail: true,
        firstBrokerLoginFlowAlias: flowAlias,
        config,
      });
      this.logger.log(`Created ${provider} identity provider in realm "${realmName}"`);
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
    return providers.map((p) => ({
      alias: p.alias,
      providerId: p.providerId,
      enabled: p.enabled,
    }));
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
}
