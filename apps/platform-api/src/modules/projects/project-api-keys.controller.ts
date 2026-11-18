import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { ProjectApiKeysService } from './project-api-keys.service';

/** The dashboard's API keys card: list, reveal (until first use), rotate, secret keys. */
@Controller('projects/:projectId/api-keys')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class ProjectApiKeysController {
  constructor(private readonly keys: ProjectApiKeysService) {}

  @Scopes('secrets:read')
  @Get()
  list(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.list(projectId, user.sub);
  }

  @Scopes('secrets:write')
  @Post('service/reveal')
  @HttpCode(200)
  reveal(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.revealServiceKey(projectId, user.sub);
  }

  @Scopes('secrets:write')
  @Post('service/rotate')
  @HttpCode(200)
  rotate(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.rotateServiceKey(projectId, user.sub);
  }

  @Scopes('secrets:write')
  @Post('anon/rotate')
  @HttpCode(200)
  rotateAnon(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.rotateAnonKey(projectId, user.sub);
  }

  @Scopes('secrets:write')
  @Post('secret')
  create(@Param('projectId') projectId: string, @Body() body: { name?: unknown }, @CurrentUser() user: JwtPayload) {
    return this.keys.createSecretKey(projectId, user.sub, body?.name);
  }

  @Scopes('secrets:write')
  @Delete('secret/:keyId')
  revoke(@Param('projectId') projectId: string, @Param('keyId') keyId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.revokeSecretKey(projectId, user.sub, keyId);
  }
}
