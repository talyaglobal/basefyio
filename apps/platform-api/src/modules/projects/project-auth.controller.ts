import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

@Controller('projects/:projectId/auth')
@UseGuards(JwtOrApiKeyGuard)
export class ProjectAuthController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly keycloak: KeycloakAdminService,
    private readonly authConfigService: ProjectAuthConfigService,
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
    return this.keycloak.createUser(project.keycloakRealm, body);
  }

  @Delete('users/:userId')
  async deleteUser(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.deleteUser(project.keycloakRealm, userId);
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
    return this.authConfigService.update(projectId, body);
  }
}
