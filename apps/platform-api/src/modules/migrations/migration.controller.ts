import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { MigrationService } from './migration.service';

@Controller()
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class MigrationController {
  constructor(private readonly migrations: MigrationService) {}

  @Scopes('blueprints:write')
  @Post('blueprints/:id/migrations/plan')
  plan(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.migrations.plan(id, user?.sub);
  }

  @Scopes('blueprints:read')
  @Get('blueprints/:id/migrations')
  list(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.migrations.list(id, user?.sub);
  }

  @Scopes('blueprints:read')
  @Get('migrations/:runId')
  get(@Param('runId') runId: string, @CurrentUser() user: JwtPayload) {
    return this.migrations.get(runId, user?.sub);
  }

  @Scopes('blueprints:write')
  @Post('migrations/:runId/apply')
  apply(
    @Param('runId') runId: string,
    @Body() body: { force?: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.migrations.apply(runId, !!body?.force, user?.sub);
  }
}
