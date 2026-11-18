import { Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

/** Every route is scoped to the caller: the user id always comes from the JWT. */
@Controller('notifications')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Scopes('account:read')
  @Get()
  list(@CurrentUser() user: JwtPayload, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.notifications.list(user.sub, parseInt(limit ?? '', 10) || 50, before);
  }

  @Scopes('account:write')
  @Delete()
  clear(@CurrentUser() user: JwtPayload) {
    return this.notifications.clear(user.sub);
  }

  @Scopes('account:write')
  @Post('read-all')
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.notifications.markAllRead(user.sub);
  }

  @Scopes('account:write')
  @Patch(':id/read')
  markRead(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.sub, id);
  }
}
