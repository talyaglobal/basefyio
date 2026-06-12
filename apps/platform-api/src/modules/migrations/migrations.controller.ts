import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { MigrationsService } from './migrations.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('v1/projects/:projectId/migrations')
@UseGuards(JwtAuthGuard)
export class MigrationsController {
  constructor(private readonly svc: MigrationsService) {}

  /** Compute a migration plan between two blueprint versions. */
  @Post('plan')
  async plan(
    @Param('projectId') projectId: string,
    @Body() body: { fromVersion?: number; toVersion?: number },
  ) {
    return this.svc.plan(projectId, body.fromVersion, body.toVersion);
  }

  /** Apply a previously computed migration plan to the tenant database. */
  @Post('apply')
  async apply(
    @Param('projectId') projectId: string,
    @Body() body: { migrationRunId: string; force?: boolean },
  ) {
    return this.svc.apply(projectId, body.migrationRunId, body.force ?? false);
  }

  /** List all migration runs for a project (most recent first). */
  @Get()
  async list(@Param('projectId') projectId: string) {
    return this.svc.list(projectId);
  }

  /** Get a single migration run by ID. */
  @Get(':migrationRunId')
  async get(
    @Param('projectId') projectId: string,
    @Param('migrationRunId') migrationRunId: string,
  ) {
    return this.svc.get(projectId, migrationRunId);
  }
}
