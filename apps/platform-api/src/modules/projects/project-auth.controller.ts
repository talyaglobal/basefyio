import {
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
    @Param('provider') provider: 'google' | 'github',
    @Body() body: { clientId: string; clientSecret?: string; enabled: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const publicApiUrl = this.configService.get<string>('publicApiUrl');
    const redirectUri = `${publicApiUrl}/rest/v1/auth/callback/${projectId}/${provider}`;

    const enabledField = provider === 'google' ? 'googleEnabled' : 'githubEnabled';
    const clientIdField = provider === 'google' ? 'googleClientId' : 'githubClientId';
    const secretField = provider === 'google' ? 'googleClientSecret' : 'githubClientSecret';

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
          project.keycloakRealm, provider, body.clientId, secret, redirectUri,
        );
      }
    } else if (!body.enabled) {
      await this.keycloak.deleteIdentityProvider(project.keycloakRealm, provider);
    }

    return updated;
  }

  @Get('providers')
  async listProviders(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const publicApiUrl = this.configService.get<string>('publicApiUrl');

    return {
      callbackUrls: {
        google: `${publicApiUrl}/rest/v1/auth/callback/${projectId}/google`,
        github: `${publicApiUrl}/rest/v1/auth/callback/${projectId}/github`,
      },
      providers: await this.keycloak.listIdentityProviders(project.keycloakRealm),
    };
  }
}
