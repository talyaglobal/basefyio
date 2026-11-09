import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { RootConsoleService } from './root-console.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectSleepService } from '../projects/project-sleep.service';
import { DiskUsageService } from './disk-usage.service';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PlatformAlertsService } from '../platform-alerts/platform-alerts.service';
import { TechDocsService } from './tech-docs.service';
import { AuthUsersExportService, toCsv } from './auth-users-export.service';

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
    private readonly authUsers: AuthUsersExportService,
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
  /**
   * Turn the Supabase-compatible surfaces (`/api/auth/v1`, `/api/storage/v1`, the storage
   * catalog, the GoTrue claim mappers) on or off for one project. Off for every project
   * until a ROOT turns it on here.
   */
  @Patch('projects/:id/supabase-compat')
  setSupabaseCompat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { enabled?: unknown },
    @CurrentUser() user: JwtPayload,
  ) {
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
    return this.console.setSupabaseCompat(id, body.enabled, user.sub);
  }

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

  /**
   * The end users of every project that is not deleted, for the owner's promotional mail.
   * Per-project failures come back in `errors` (JSON) or the X-Export-Errors header (CSV).
   */
  @Get('auth-users')
  async authUsersExport(
    @Query('projectId') projectId: string | undefined,
    @Query('format') format: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (projectId !== undefined && !/^[0-9a-f-]{36}$/i.test(projectId)) throw new BadRequestException('projectId must be a UUID');
    if (format !== undefined && format !== 'json' && format !== 'csv') throw new BadRequestException('format must be json or csv');
    const result = await this.authUsers.collect(projectId);
    this.authUsers.audit(user.sub, format ?? 'json', result);
    if (format !== 'csv') return result;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="auth-users-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Export-Errors', String(result.errors.length));
    res.setHeader('Access-Control-Expose-Headers', 'X-Export-Errors, Content-Disposition');
    return toCsv(result.rows);
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
