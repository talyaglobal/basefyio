import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { ProjectApiKeysService } from './project-api-keys.service';

/** The dashboard's API keys card: list, reveal (until first use), rotate, secret keys. */
@Controller('projects/:projectId/api-keys')
@UseGuards(JwtAuthGuard)
export class ProjectApiKeysController {
  constructor(private readonly keys: ProjectApiKeysService) {}

  @Get()
  list(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.list(projectId, user.sub);
  }

  @Post('service/reveal')
  @HttpCode(200)
  reveal(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.revealServiceKey(projectId, user.sub);
  }

  @Post('service/rotate')
  @HttpCode(200)
  rotate(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.rotateServiceKey(projectId, user.sub);
  }

  @Post('anon/rotate')
  @HttpCode(200)
  rotateAnon(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.rotateAnonKey(projectId, user.sub);
  }

  @Post('secret')
  create(@Param('projectId') projectId: string, @Body() body: { name?: unknown }, @CurrentUser() user: JwtPayload) {
    return this.keys.createSecretKey(projectId, user.sub, body?.name);
  }

  @Delete('secret/:keyId')
  revoke(@Param('projectId') projectId: string, @Param('keyId') keyId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.revokeSecretKey(projectId, user.sub, keyId);
  }
}
