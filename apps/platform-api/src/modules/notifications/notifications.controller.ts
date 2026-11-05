import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

class CreateNotificationDto {
  @IsString() @MaxLength(32) type: string;
  @IsString() @MaxLength(200) title: string;
  @IsString() @MaxLength(1000) message: string;
  @IsOptional() @IsString() @MaxLength(500) href?: string;
  @IsOptional() @IsString() @MaxLength(200) dedupeKey?: string;
}

/** Every route is scoped to the caller: the user id always comes from the JWT. */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.notifications.list(user.sub, parseInt(limit ?? '', 10) || 50, before);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateNotificationDto) {
    return this.notifications.create(user.sub, dto);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.notifications.markAllRead(user.sub);
  }

  @Patch(':id/read')
  markRead(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.sub, id);
  }
}
