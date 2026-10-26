import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { RootConsoleService } from './root-console.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectSleepService } from '../projects/project-sleep.service';
import { DiskUsageService } from './disk-usage.service';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PlatformAlertsService } from '../platform-alerts/platform-alerts.service';
import { TechDocsService } from './tech-docs.service';

/** The root console on admin.<domain>: platform-wide figures, root only. */
@Controller('admin/console')
@UseGuards(JwtAuthGuard, RootRoleGuard)
export class RootConsoleController {
  constructor(
    private readonly console: RootConsoleService,
    private readonly diskUsage: DiskUsageService,
    private readonly alerts: PlatformAlertsService,
    private readonly projectRepair: ProjectsService,
    private readonly sleep: ProjectSleepService,
    private readonly techDocs: TechDocsService,
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

  /** The red badge across the top of the console: unacknowledged events and live conditions. */
  @Get('alerts')
  async alertFeed() {
    return this.alerts.getFeed(await this.diskUsage.getFilesystems());
  }

  @Post('alerts/acknowledge-all')
  acknowledgeAllAlerts(@CurrentUser() user: JwtPayload) {
    return this.alerts.acknowledgeAll(user.sub);
  }

  @Post('alerts/:id/acknowledge')
  acknowledgeAlert(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.alerts.acknowledge(id, user.sub);
  }

  /**
   * Put back a live project's database or authentication realm when it is
   * missing. Additive and safe to repeat; the result says what it created and
   * whether the project's API keys had to be reissued.
   */
  @Post('projects/:id/repair-provisioning')
  repairProvisioning(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectRepair.repairProvisioning(id);
  }

  /**
   * What the idle sweep would do if it ran now, without doing any of it.
   * Worth reading before switching the sweep on: on a platform where most
   * projects are abandoned experiments, the first run reaches a lot of people.
   */
  @Get('idle-projects')
  idleProjects() {
    return this.sleep.preview();
  }

  @Get('storage')
  storage() {
    return this.console.getStorage();
  }

  @Post('storage/refresh')
  refreshStorage() {
    return this.console.refreshStorage();
  }

  /** The technical documentation: every page's title, section and age; bodies on request. */
  @Get('techdocs')
  listTechDocs() {
    return this.techDocs.list();
  }

  @Get('techdocs/:slug')
  getTechDoc(@Param('slug') slug: string) {
    return this.techDocs.get(slug);
  }
}
