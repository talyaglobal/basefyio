import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { TeamIntegrationsService } from './team-integrations.service';
import { TeamsService } from '../teams/teams.service';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

@Controller('team-integrations')
export class TeamIntegrationsController {
  constructor(
    private readonly service: TeamIntegrationsService,
    private readonly teams: TeamsService,
  ) {}

  // ── GitHub ──────────────────────────────────────────────────

  @Get(':teamId/github/status')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:read')
  getGitHubStatus(@Param('teamId') teamId: string) {
    return this.service.getGitHubStatus(teamId);
  }

  @Get(':teamId/github/connect-url')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:read')
  async getGitHubConnectUrl(
    @Param('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    const url = await this.service.getGitHubConnectUrl(teamId);
    return { url };
  }

  @Get('github/callback')
  async githubCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const redirectUrl = await this.service.handleGitHubCallback(code, state);
    return res.redirect(redirectUrl);
  }

  @Post(':teamId/github/connect-pat')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:write')
  async connectGitHubWithPat(
    @Param('teamId') teamId: string,
    @Body('token') token: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    await this.service.connectGitHubWithPat(teamId, token);
    return { connected: true };
  }

  @Delete(':teamId/github')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:write')
  async disconnectGitHub(
    @Param('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    return this.service.disconnectGitHub(teamId);
  }

  @Get(':teamId/github/repos')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:read')
  listGitHubRepos(@Param('teamId') teamId: string) {
    return this.service.listGitHubRepos(teamId);
  }

  @Get(':teamId/github/branches')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:read')
  listGitHubBranches(
    @Param('teamId') teamId: string,
    @Query('owner') owner: string,
    @Query('repo') repo: string,
  ) {
    return this.service.listGitHubBranches(teamId, owner, repo);
  }

  // ── Vercel ──────────────────────────────────────────────────

  @Get(':teamId/vercel/status')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:read')
  getVercelStatus(@Param('teamId') teamId: string) {
    return this.service.getVercelStatus(teamId);
  }

  @Get(':teamId/vercel/connect-url')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:read')
  async getVercelConnectUrl(
    @Param('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    const url = await this.service.getVercelConnectUrl(teamId);
    return { url };
  }

  @Get('vercel/callback')
  async vercelCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const redirectUrl = await this.service.handleVercelCallback(code, state);
    return res.redirect(redirectUrl);
  }

  @Post(':teamId/vercel/connect')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:write')
  async connectVercel(
    @Param('teamId') teamId: string,
    @Body('token') token: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    return this.service.connectVercelWithToken(teamId, token);
  }

  @Delete(':teamId/vercel')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:write')
  async disconnectVercel(
    @Param('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    return this.service.disconnectVercel(teamId);
  }

  @Get(':teamId/vercel/projects')

  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)

  @Scopes('integrations:read')
  listVercelProjects(@Param('teamId') teamId: string) {
    return this.service.listVercelProjects(teamId);
  }
}
