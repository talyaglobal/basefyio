import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { FoldersTagsService } from './folders-tags.service';

// ── Folders controller ────────────────────────────────────────────────────────
// Note: using /project-folders and /project-tags instead of /projects/folders
// to avoid conflicts with the /projects/:id route in ProjectsController.
@Controller('project-folders')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class FoldersController {
  constructor(private readonly svc: FoldersTagsService) {}

  @Scopes('settings:read')
  @Get()
  list(@Query('teamId') teamId: string, @CurrentUser() user: JwtPayload) {
    return this.svc.listFolders(teamId, user.sub);
  }

  @Scopes('settings:write')
  @Post()
  create(
    @Body() body: { teamId: string; name: string; color?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.svc.createFolder(body.teamId, user.sub, body.name, body.color);
  }

  @Scopes('settings:write')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; color?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.svc.updateFolder(id, user.sub, body);
  }

  @Scopes('settings:write')
  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.deleteFolder(id, user.sub);
  }
}

// ── Tags controller ───────────────────────────────────────────────────────────
@Controller('project-tags')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class TagsController {
  constructor(private readonly svc: FoldersTagsService) {}

  @Scopes('settings:read')
  @Get()
  list(@Query('teamId') teamId: string, @CurrentUser() user: JwtPayload) {
    return this.svc.listTags(teamId, user.sub);
  }

  @Scopes('settings:write')
  @Post()
  create(
    @Body() body: { teamId: string; name: string; color?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.svc.createTag(body.teamId, user.sub, body.name, body.color);
  }

  @Scopes('settings:write')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; color?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.svc.updateTag(id, user.sub, body);
  }

  @Scopes('settings:write')
  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.deleteTag(id, user.sub);
  }
}
