import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectsService } from './projects.service';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

const OAUTH_PROVIDERS = [
  'google',
  'microsoft',
  'apple',
  'github',
  'gitlab',
  'linkedin',
  'facebook',
  'twitter',
] as const;
type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

@Controller('projects/:projectId/auth')
@UseGuards(JwtOrApiKeyGuard)
export class ProjectAuthController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly keycloak: KeycloakAdminService,
    private readonly authConfigService: ProjectAuthConfigService,
    private readonly configService: ConfigService,
    private readonly activity: ProjectActivityService,
  ) {}

  @Get()
  async getRealmInfo(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.getRealmInfo(project.keycloakRealm);
  }

  @Get('users')
  async listUsers(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.listUsers(project.keycloakRealm);
  }

  @Post('users')
  async createUser(
    @Param('projectId') projectId: string,
    @Body() body: { email: string; password: string; firstName?: string; lastName?: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const created = await this.keycloak.createUser(project.keycloakRealm, body);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_CREATED,
      title: `Auth user created: ${body.email}`,
    });
    return created;
  }

  @Patch('users/:userId')
  async updateUser(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: { firstName?: string; lastName?: string; email?: string; enabled?: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    await this.keycloak.updateRealmUser(project.keycloakRealm, userId, body);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `Auth user updated: ${userId}`,
      detail: Object.keys(body).join(', '),
    });
    return { message: 'User updated' };
  }

  @Post('users/:userId/reset-password')
  async resetUserPassword(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: { newPassword: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    await this.keycloak.resetRealmUserPassword(project.keycloakRealm, userId, body.newPassword);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_PASSWORD_RESET,
      title: `Auth user password reset: ${userId}`,
    });
    return { message: 'Password reset successfully' };
  }

  @Delete('users/:userId')
  async deleteUser(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.keycloak.deleteUser(project.keycloakRealm, userId);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_DELETED,
      title: `Auth user deleted: ${userId}`,
    });
    return result;
  }

  @Get('config')
  async getConfig(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.projectsService.findOne(projectId, user?.sub);
    return this.authConfigService.getOrCreate(projectId);
  }

  @Put('config')
  async updateConfig(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, any>,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.projectsService.findOne(projectId, user?.sub);
    return this.authConfigService.update(projectId, body, user?.sub);
  }

  @Put('providers/:provider')
  async saveProvider(
    @Param('projectId') projectId: string,
    @Param('provider') provider: string,
    @Body() body: { clientId: string; clientSecret?: string; enabled: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    if (!OAUTH_PROVIDERS.includes(provider as OAuthProvider)) {
      throw new BadRequestException(`Unsupported provider: ${provider}`);
    }
    const p = provider as OAuthProvider;
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const publicApiUrl = this.configService.get<string>('publicApiUrl');
    const redirectUri = `${publicApiUrl}/rest/v1/auth/callback/${projectId}/${p}`;
    const cap = `${p.charAt(0).toUpperCase()}${p.slice(1)}`;
    const enabledField = `${p}Enabled`;
    const clientIdField = `${p}ClientId`;
    const secretField = `${p}ClientSecret`;

    const updateData: Record<string, any> = {
      [enabledField]: body.enabled,
      [clientIdField]: body.clientId,
    };
    if (body.clientSecret) {
      updateData[secretField] = body.clientSecret;
    }

    const updated = await this.authConfigService.update(
      projectId,
      updateData,
      user?.sub,
    );

    if (body.enabled && body.clientId) {
      const rawCfg = await this.authConfigService.getRaw(projectId);
      const secret = (rawCfg as any)[secretField];
      if (secret) {
        await this.keycloak.upsertIdentityProvider(
          project.keycloakRealm, p, body.clientId, secret, redirectUri,
        );
      }
    } else if (!body.enabled) {
      await this.keycloak.deleteIdentityProvider(project.keycloakRealm, p);
    }

    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
      title: `OAuth provider updated: ${cap}`,
      detail: body.enabled ? 'Enabled' : 'Disabled',
      metadata: { provider: p, enabled: body.enabled },
    });

    return updated;
  }

  @Get('providers')
  async listProviders(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const publicApiUrl = this.configService.get<string>('publicApiUrl');
    const callbackUrls = OAUTH_PROVIDERS.reduce<Record<string, string>>((acc, p) => {
      acc[p] = `${publicApiUrl}/rest/v1/auth/callback/${projectId}/${p}`;
      return acc;
    }, {});

    return {
      callbackUrls,
      providers: await this.keycloak.listIdentityProviders(project.keycloakRealm),
    };
  }

  @Post('repair')
  async repairRealm(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const realmName = project.keycloakRealm;
    const exists = await this.keycloak.realmExists(realmName);
    if (exists) {
      return { message: 'Realm is healthy, no repair needed', realm: realmName };
    }

    await this.keycloak.createRealm(realmName);
    await this.keycloak.createClients(realmName);

    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
      title: 'Authentication realm repaired',
      detail: `Realm "${realmName}" was re-provisioned`,
    });

    return { message: 'Realm repaired successfully', realm: realmName };
  }
}
