import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import KcAdminClient from '@keycloak/keycloak-admin-client';
import { v4 as uuid } from 'uuid';

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

  async findPlatformUserByEmail(email: string) {
    await this.ensureAuth();
    const users = await this.client.users.find({
      realm: 'master',
      email,
      exact: true,
    });
    return users[0] || null;
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
