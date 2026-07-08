import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { ApiTokensService, CreateTokenInput } from './api-tokens.service';
import { SCOPE_GROUPS } from './api-tokens.constants';

/**
 * Manage your own platform API tokens. Dashboard-JWT only — a token cannot mint
 * more tokens.
 */
@Controller('account/api-tokens')
@UseGuards(JwtAuthGuard)
export class ApiTokensController {
  constructor(private readonly service: ApiTokensService) {}

  @Get('scopes')
  scopes() {
    return SCOPE_GROUPS;
  }

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.service.list(user.sub);
  }

  @Post()
  create(@Body() body: CreateTokenInput, @CurrentUser() user: JwtPayload) {
    return this.service.create(user.sub, body);
  }

  @Post(':id/roll')
  roll(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.roll(user.sub, id);
  }

  @Delete(':id')
  revoke(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.revoke(user.sub, id);
  }
}
