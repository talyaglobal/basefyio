import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { S3KeysService } from './s3-keys.service';

/**
 * S3 access keys of a project (feedback #225). Keys are credentials, so they sit with the other
 * project credentials under `secrets:*`, never `storage:*`: a storage token cannot mint one.
 * The secret is in the create response only.
 */
@Controller('projects/:projectId/storage/s3-keys')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class S3KeysController {
  constructor(private readonly keys: S3KeysService) {}

  @Scopes('secrets:read')
  @Get('info')
  info(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.info(projectId, user.sub);
  }

  @Scopes('secrets:read')
  @Get()
  list(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.keys.list(projectId, user.sub);
  }

  @Scopes('secrets:write')
  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() body: { name?: unknown },
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
  ) {
    return this.keys.create(projectId, user.sub, body?.name, req?.platformToken ? 'token' : 'session');
  }

  @Scopes('secrets:write')
  @Delete(':keyId')
  revoke(
    @Param('projectId') projectId: string,
    @Param('keyId') keyId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
  ) {
    return this.keys.revoke(projectId, user.sub, keyId, req?.platformToken ? 'token' : 'session');
  }
}
