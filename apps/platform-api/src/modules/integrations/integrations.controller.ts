import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { ConnectGitHubDto } from './dto/connect-github.dto';
import { ConnectVercelDto } from './dto/connect-vercel.dto';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

@Controller('projects/:projectId/integrations')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  // ── GitHub ──────────────────────────────────────────

  @Scopes('integrations:write')
  @Put('github')
  async connectGitHub(
    @Param('projectId') projectId: string,
    @Body() body: ConnectGitHubDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.connectGitHub(projectId, user.sub, {
      token: body.token,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      useTeamToken: body.useTeamToken,
      teamId: body.teamId,
    });
  }

  @Scopes('integrations:write')
  @Delete('github')
  async disconnectGitHub(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.disconnectGitHub(projectId, user.sub);
  }

  @Scopes('integrations:read')
  @Get('github')
  async getGitHubStatus(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getGitHubStatus(projectId, user.sub);
  }

  @Scopes('integrations:read')
  @Get('github/repos')
  async listGitHubRepos(
    @Param('projectId') projectId: string,
    @Query('token') token: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.listGitHubRepos(projectId, user.sub, token);
  }

  @Scopes('integrations:read')
  @Get('github/commits')
  async getGitHubCommits(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getGitHubCommits(projectId, user.sub);
  }

  @Scopes('integrations:read')
  @Get('github/branches')
  async getGitHubBranches(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getGitHubBranches(projectId, user.sub);
  }

  @Scopes('integrations:read')
  @Get('github/branches/preview')
  async previewGitHubBranches(
    @Param('projectId') projectId: string,
    @Query('token') token: string,
    @Query('owner') owner: string,
    @Query('repo') repo: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.previewGitHubBranches(projectId, user.sub, token, owner, repo);
  }

  // ── Vercel ──────────────────────────────────────────

  @Scopes('integrations:write')
  @Put('vercel')
  async connectVercel(
    @Param('projectId') projectId: string,
    @Body() body: ConnectVercelDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.connectVercel(projectId, user.sub, {
      token: body.token,
      projectId: body.projectId,
      teamId: body.teamId,
      useTeamToken: body.useTeamToken,
      sourceTeamId: body.sourceTeamId,
    });
  }

  @Scopes('integrations:write')
  @Delete('vercel')
  async disconnectVercel(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.disconnectVercel(projectId, user.sub);
  }

  @Scopes('integrations:read')
  @Get('vercel')
  async getVercelStatus(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getVercelStatus(projectId, user.sub);
  }

  @Scopes('integrations:read')
  @Get('vercel/projects')
  async listVercelProjects(
    @Param('projectId') projectId: string,
    @Query('token') token: string,
    @Query('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.listVercelProjects(projectId, user.sub, token, teamId);
  }

  @Scopes('integrations:read')
  @Get('vercel/deployments')
  async getVercelDeployments(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getVercelDeployments(projectId, user.sub);
  }

  @Scopes('integrations:write')
  @Post('vercel/sync-env')
  async syncEnvToVercel(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.syncEnvToVercel(projectId, user.sub);
  }
}
