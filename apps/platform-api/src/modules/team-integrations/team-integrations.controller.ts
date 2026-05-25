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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
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
  @UseGuards(JwtAuthGuard)
  getGitHubStatus(@Param('teamId') teamId: string) {
    return this.service.getGitHubStatus(teamId);
  }

  @Get(':teamId/github/connect-url')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  async disconnectGitHub(
    @Param('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    return this.service.disconnectGitHub(teamId);
  }

  @Get(':teamId/github/repos')
  @UseGuards(JwtAuthGuard)
  listGitHubRepos(@Param('teamId') teamId: string) {
    return this.service.listGitHubRepos(teamId);
  }

  @Get(':teamId/github/branches')
  @UseGuards(JwtAuthGuard)
  listGitHubBranches(
    @Param('teamId') teamId: string,
    @Query('owner') owner: string,
    @Query('repo') repo: string,
  ) {
    return this.service.listGitHubBranches(teamId, owner, repo);
  }

  // ── Vercel ──────────────────────────────────────────────────

  @Get(':teamId/vercel/status')
  @UseGuards(JwtAuthGuard)
  getVercelStatus(@Param('teamId') teamId: string) {
    return this.service.getVercelStatus(teamId);
  }

  @Get(':teamId/vercel/connect-url')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  async connectVercel(
    @Param('teamId') teamId: string,
    @Body('token') token: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    return this.service.connectVercelWithToken(teamId, token);
  }

  @Delete(':teamId/vercel')
  @UseGuards(JwtAuthGuard)
  async disconnectVercel(
    @Param('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.teams.assertPermission(teamId, user.sub, 'canManageIntegrations');
    return this.service.disconnectVercel(teamId);
  }

  @Get(':teamId/vercel/projects')
  @UseGuards(JwtAuthGuard)
  listVercelProjects(@Param('teamId') teamId: string) {
    return this.service.listVercelProjects(teamId);
  }
}
