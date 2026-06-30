import {
  Body,
  Controller,
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
import { MigrationService } from './migration.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class MigrationController {
  constructor(private readonly migrations: MigrationService) {}

  @Post('blueprints/:id/migrations/plan')
  plan(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.migrations.plan(id, user?.sub);
  }

  @Get('blueprints/:id/migrations')
  list(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.migrations.list(id, user?.sub);
  }

  @Get('migrations/:runId')
  get(@Param('runId') runId: string, @CurrentUser() user: JwtPayload) {
    return this.migrations.get(runId, user?.sub);
  }

  @Post('migrations/:runId/apply')
  apply(
    @Param('runId') runId: string,
    @Body() body: { force?: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.migrations.apply(runId, !!body?.force, user?.sub);
  }
}
