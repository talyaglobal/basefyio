import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { RootConsoleService } from './root-console.service';
import { DiskUsageService } from './disk-usage.service';

/** The root console on admin.<domain>: platform-wide figures, root only. */
@Controller('admin/console')
@UseGuards(JwtAuthGuard, RootRoleGuard)
export class RootConsoleController {
  constructor(
    private readonly console: RootConsoleService,
    private readonly diskUsage: DiskUsageService,
  ) {}

  @Get('overview')
  overview() {
    return this.console.getOverview();
  }

  @Get('projects')
  projects(@Query('includeDeleted') includeDeleted?: string) {
    return this.console.listProjects(includeDeleted === 'true');
  }

  @Get('projects/:id')
  project(@Param('id', ParseUUIDPipe) id: string) {
    return this.console.getProject(id);
  }

  /** Host disks and what fills the data volume. */
  @Get('disk')
  disk() {
    return this.diskUsage.getDisk();
  }

  @Get('storage')
  storage() {
    return this.console.getStorage();
  }

  @Post('storage/refresh')
  refreshStorage() {
    return this.console.refreshStorage();
  }
}
