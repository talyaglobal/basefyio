import {
  BadRequestException,
  Controller,
  Get,
  Post,
  HttpCode,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ProjectsService } from './projects.service';
import { SupabaseImportService } from './supabase-import.service';
import { ProjectExportService } from './project-export.service';
import { ProjectPitrService } from './project-pitr.service';
import { PitrRestoreJobsService } from './pitr-restore-jobs.service';
import { CreateProjectDto, UpdateDataAccessDto, UpdateRestSchemasDto } from './dto/create-project.dto';
import { ImportSupabaseDto } from './dto/import-supabase.dto';
import { RepairImportKeysDto } from './dto/repair-import-keys.dto';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { JwtOnly, Scopes } from '../api-tokens/scopes.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { ProjectActivityService } from './project-activity.service';
import { ProjectArchiveImportService } from './project-archive-import.service';

@Controller('projects')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly supabaseImport: SupabaseImportService,
    private readonly projectExport: ProjectExportService,
    private readonly projectArchiveImport: ProjectArchiveImportService,
    private readonly projectActivity: ProjectActivityService,
    private readonly projectPitr: ProjectPitrService,
    private readonly pitrRestoreJobs: PitrRestoreJobsService,
  ) {}

  // Typed as the class itself, not an intersection: an intersection compiles
  // to `Object` and the validation pipe silently skipped it, so nothing in
  // the body was ever checked.
  @Scopes('projects:write')
  @Post()
  async create(@Body() body: CreateProjectDto, @CurrentUser() user: JwtPayload) {
    return this.projectsService.create(body, user.sub);
  }

  @Scopes('projects:write')
  @Post('import-supabase')
  async importFromSupabase(
    @Body() body: ImportSupabaseDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.supabaseImport.importProject(
      body.supabaseUrl,
      body.serviceRoleKey,
      body.name,
      body.teamId,
      user.sub,
      body.databasePassword,
      body.existingProjectId,
      body.mode ?? 'full',
      body.repairKeys ?? false,
    );
  }

  /**
   * Add the source's primary keys to tables that were imported without one.
   * Dry run by request; otherwise DDL runs on the project database as its own
   * user, one table per transaction, only where the rows are unique on the key.
   */
  @Scopes('projects:write')
  @Post(':id/import-supabase/repair-keys')
  async repairSupabaseImportKeys(
    @Param('id') id: string,
    @Body() body: RepairImportKeysDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.supabaseImport.repairImportedPrimaryKeys(id, user.sub, body);
  }

  @Scopes('projects:write')
  @Post('import-export-zip')
  @UseInterceptors(FileInterceptor('file', { storage: undefined }))
  async importExportZip(
    @CurrentUser() user: JwtPayload,
    @Body()
    body: {
      teamId?: string;
      nameMode?: 'existing' | 'new';
      newProjectName?: string;
      existingProjectId?: string;
      confirmProjectName?: string;
    },
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.projectArchiveImport.importArchive(file, user.sub, body);
  }

  @Scopes('projects:write')
  @Post('import-supabase/validate')
  async validateSupabase(
    @Body() body: { supabaseUrl: string; serviceRoleKey: string },
  ) {
    return this.supabaseImport.validateAndGetInfo(
      body.supabaseUrl,
      body.serviceRoleKey,
    );
  }

  @Scopes('projects:write')
  @Post('import-supabase/jobs/:jobId/cancel')
  async cancelImport(
    @Param('jobId') jobId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.supabaseImport.cancelImport(jobId, user.sub);
  }

  @Scopes('projects:read')
  @Get('import-supabase/jobs/:jobId/status')
  async getJobStatus(@Param('jobId') jobId: string) {
    const status = await this.supabaseImport.getJobStatus(jobId);
    if (!status) {
      return { error: 'Job not found' };
    }
    return status;
  }

  @Scopes('projects:read')
  @Get('import-supabase/jobs/:jobId/events')
  async streamJobEvents(
    @Param('jobId') jobId: string,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('connected', { jobId });

    let lastProgressJson = '';
    let lastState = '';
    let finished = false;
    const pollInterval = 500;

    const poll = async () => {
      if (finished) return;

      try {
        const status = await this.supabaseImport.getJobStatus(jobId);

        if (!status) {
          sendEvent('failed', { error: 'Job not found' });
          finished = true;
          res.end();
          return;
        }

        if (status.state !== lastState) {
          lastState = status.state;
          sendEvent('state', { state: status.state });
        }

        const progressJson = JSON.stringify(status.progress || {});
        if (progressJson !== lastProgressJson && progressJson !== '{}') {
          lastProgressJson = progressJson;
          sendEvent('progress', status.progress);
        }

        if (status.state === 'completed') {
          let resultData = status.result;
          if (!resultData || (typeof resultData === 'object' && !resultData.database)) {
            const freshStatus = await this.supabaseImport.getJobStatus(jobId);
            if (freshStatus?.result) {
              resultData = freshStatus.result;
            }
          }
          if (!resultData) {
            const p = status.progress;
            if (
              p &&
              typeof p === 'object' &&
              'progress' in p &&
              (p as { progress?: unknown }).progress != null
            ) {
              resultData = (p as { progress: typeof resultData }).progress;
            }
          }
          sendEvent('completed', {
            progress: resultData,
          });
          finished = true;
          res.end();
          return;
        }

        if (status.state === 'failed') {
          sendEvent('failed', {
            error: status.failedReason || 'Import failed',
          });
          finished = true;
          res.end();
          return;
        }
      } catch (err: any) {
        sendEvent('failed', { error: err.message || 'Import status stream failed' });
        finished = true;
        res.end();
        return;
      }

      if (!finished) {
        setTimeout(poll, pollInterval);
      }
    };

    poll();

    // Clean up on client disconnect
    res.on('close', () => {
      finished = true;
    });
  }

  @Scopes('projects:read')
  @Get()
  async findAll(
    @Query('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.findAll(teamId, user.sub);
  }

  @Scopes('projects:read')
  @Get('deleted')
  async findDeleted(
    @Query('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.findDeleted(teamId, user.sub);
  }

  @Scopes('projects:read')
  @Get('deactivated')
  async findDeactivated(
    @Query('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.findDeactivated(teamId, user.sub);
  }

  /**
   * The compute sizes the New project dialog may offer for a team, with the reason each
   * unavailable one is disabled. Declared before ':id' so the path is not read as an id.
   */
  @Scopes('projects:read')
  @Get('compute-options')
  async computeOptions(@Query('teamId') teamId: string, @CurrentUser() user: JwtPayload) {
    return this.projectsService.computeOptions(teamId, user.sub);
  }

  /**
   * The Overview's resources card: region, compute, database and file storage against the
   * plan. Dashboard session only; no token scope covers it.
   */
  @JwtOnly()
  @Get(':id/resources')
  async resources(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.projectsService.resources(id, user.sub);
  }

  // Declared before the ':id/...' routes so "pitr" is not read as a project id.
  @JwtOnly()
  @Post('pitr/run-base-backup')
  async runClusterBaseBackup(@CurrentUser() user: JwtPayload) {
    return this.projectPitr.runClusterBaseBackupNow(user.sub);
  }

  /** Settings → Data access: the Data API, automatic grants on new tables, RLS on new tables. */
  @Scopes('settings:write')
  @Patch(':id/data-access')
  async updateDataAccess(
    @Param('id') id: string,
    @Body() body: UpdateDataAccessDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.updateDataAccess(id, user.sub, body);
  }

  /**
   * Settings → API: the schemas the REST data API serves besides `public` (#264).
   * Dashboard session only: widening what the API keys can reach is never a token's call.
   */
  @JwtOnly()
  @Get(':id/rest-schemas')
  async getRestSchemas(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.projectsService.getRestSchemas(id, user.sub);
  }

  @JwtOnly()
  @Patch(':id/rest-schemas')
  async updateRestSchemas(
    @Param('id') id: string,
    @Body() body: UpdateRestSchemasDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.updateRestSchemas(id, user.sub, body.exposedSchemas);
  }

  @Scopes('settings:write')
  @Patch(':id/max-rows')
  async setMaxRowsPerTable(
    @Param('id') id: string,
    @Body('maxRowsPerTable') maxRowsPerTable: number,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.setMaxRowsPerTable(id, user.sub, Number(maxRowsPerTable));
  }

  @JwtOnly() // platform operators only (ROOT)
  @Get('deletion-reasons')
  async listDeletionReasons(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    return this.projectsService.listDeletionReasons(user.sub, limit);
  }

  @Scopes('logs:read')
  @Get(':id/activity')
  async listProjectActivity(
    @Param('id') id: string,
    @Query('limit') limitRaw: string | undefined,
    @Query('page') pageRaw: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Query('q') q?: string,
    @Query('kind') kind?: string,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const page = pageRaw ? parseInt(pageRaw, 10) : undefined;
    const date = (v?: string) => {
      if (!v) return undefined;
      const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date: ${v}`);
      return d;
    };
    const to = date(toRaw);
    // A bare date for "to" means the whole day.
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(toRaw ?? '')) to.setUTCHours(23, 59, 59, 999);
    return this.projectActivity.listForProject(id, user.sub, {
      limit,
      page,
      q: q?.slice(0, 200),
      kind: kind?.slice(0, 80),
      from: date(fromRaw),
      to,
    });
  }

  @Scopes('projects:read')
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.findOne(id, user.sub);
  }

  @Scopes('projects:write')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { folderId?: string | null; tags?: string[]; name?: string; description?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.update(id, user.sub, body);
  }

  @JwtOnly()
  @Post(':id/move-to-team')
  async moveToTeam(
    @Param('id') id: string,
    @Body('teamId') targetTeamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.moveToTeam(id, targetTeamId, user.sub);
  }

  @Scopes('secrets:write')
  @Patch(':id/db-password')
  async rotateDbPassword(
    @Param('id') id: string,
    @Body() body: { password?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.rotateDatabasePassword(id, user.sub, body.password);
  }

  /**
   * Read-only companion role (<dbUser>_readonly): SELECT on everything, no
   * writes. Create (or repair) it, rotate its password, or remove it. Same
   * permission as rotating the owner password.
   */
  @Scopes('secrets:write')
  @Post(':id/db-readonly-role')
  async createReadonlyRole(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.projectsService.createReadonlyRole(id, user.sub);
  }

  @Scopes('secrets:write')
  @Patch(':id/db-readonly-password')
  async rotateReadonlyPassword(
    @Param('id') id: string,
    @Body() body: { password?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.rotateReadonlyPassword(id, user.sub, body?.password);
  }

  @Scopes('secrets:write')
  @Delete(':id/db-readonly-role')
  async dropReadonlyRole(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.projectsService.dropReadonlyRole(id, user.sub);
  }

  /**
   * Extra database roles: named LOGIN roles a project owner creates so each
   * service or worker can connect with its own least-privilege identity.
   */
  @Scopes('secrets:read')
  @Get(':id/db-extra-roles')
  async listExtraRoles(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.projectsService.listExtraRoles(id, user.sub);
  }

  @Scopes('secrets:write')
  @Post(':id/db-extra-roles')
  async createExtraRole(
    @Param('id') id: string,
    @Body() body: { label: string; memberOf?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const memberOf = (body?.memberOf as any) || 'none';
    return this.projectsService.createExtraRole(id, user.sub, body?.label, memberOf);
  }

  @Scopes('secrets:write')
  @Patch(':id/db-extra-roles/:roleId/password')
  async rotateExtraRolePassword(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Body() body: { password?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.rotateExtraRolePassword(id, user.sub, roleId, body?.password);
  }

  @Scopes('secrets:write')
  @Delete(':id/db-extra-roles/:roleId')
  async dropExtraRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.dropExtraRole(id, user.sub, roleId);
  }

  /** Pooler connection cap for this database; null = back to the plan default. */
  @Scopes('settings:write')
  @Patch(':id/db-connection-limit')
  async setDbConnectionLimit(
    @Param('id') id: string,
    @Body() body: { maxDbConnections: number | null },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.setMaxDbConnections(id, user.sub, body?.maxDbConnections ?? null);
  }

  /**
   * (Re)apply the RLS bootstrap (anon/authenticated/service_role roles, auth.*
   * helpers, default-privilege grants) to this project's database. Idempotent;
   * use to recover legacy projects whose data API returns
   * "permission denied to set role anon" / "service_role".
   */
  @Scopes('schema:write')
  @Post(':id/ensure-rls-bootstrap')
  async ensureRlsBootstrap(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    // Authorize via the standard project-membership check before touching the DB.
    await this.projectsService.findOne(id, user.sub);
    return this.projectsService.ensureRlsBootstrap(id);
  }

  /**
   * Read-only diagnostic for the data API's RLS plumbing. Returns:
   *   - which of anon/authenticated/service_role exist in the project DB
   *   - the project owner's role memberships (pg_auth_members)
   *   - a live SET ROLE round-trip for each target role
   * Use this when the data API returns 500 "permission denied to set role <X>"
   * to figure out which step is broken before triggering a re-bootstrap.
   */
  @Scopes('schema:read')
  @Get(':id/rls-diagnose')
  async diagnoseRls(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.projectsService.findOne(id, user.sub);
    return this.projectsService.diagnoseRls(id);
  }

  @Scopes('projects:write')
  @Post(':id/restore')
  async restore(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.restore(id, user.sub);
  }

  @Scopes('projects:write')
  @Post(':id/deactivate')
  async deactivate(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.deactivate(id, user.sub);
  }

  @Scopes('projects:write')
  @Post(':id/reactivate')
  async reactivate(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.reactivate(id, user.sub);
  }

  @Scopes('projects:write')
  @Post(':id/sleep')
  async sleep(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.sleep(id, user.sub);
  }

  @Scopes('projects:write')
  @Delete(':id/permanent')
  async permanentDelete(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.permanentDelete(id, user.sub);
  }

  @Scopes('projects:write')
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body()
    body?: {
      reasonCode?: string;
      reasonLabel?: string;
      details?: string;
    },
  ) {
    return this.projectsService.remove(id, user.sub, body);
  }

  @Scopes('backups:write')
  @Post(':id/export')
  async startExport(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body()
    body?: {
      includeDatabase?: boolean;
      includeAuth?: boolean;
      includeStorage?: boolean;
      includeConfig?: boolean;
    },
  ) {
    return this.projectExport.startExport(id, user.sub, body);
  }

  @Scopes('backups:read')
  @Get(':id/export/jobs/:jobId/status')
  async getExportStatus(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const status = await this.projectExport.getJobStatus(id, jobId, user.sub);
    if (!status) {
      return { error: 'Job not found' };
    }
    return status;
  }

  @Scopes('backups:read')
  @Get(':id/export/jobs/:jobId/events')
  async streamExportEvents(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('connected', { jobId });

    let lastProgressJson = '';
    let lastState = '';
    let finished = false;
    const pollInterval = 500;

    const poll = async () => {
      if (finished) return;

      try {
        const status = await this.projectExport.getJobStatus(id, jobId, user.sub);

        if (!status) {
          sendEvent('error', { message: 'Job not found' });
          finished = true;
          res.end();
          return;
        }

        if (status.state !== lastState) {
          lastState = status.state;
          sendEvent('state', { state: status.state });
        }

        const progressJson = JSON.stringify(status.progress || {});
        if (progressJson !== lastProgressJson && progressJson !== '{}') {
          lastProgressJson = progressJson;
          sendEvent('progress', status.progress);
        }

        if (status.state === 'completed') {
          sendEvent('completed', status.result || {});
          finished = true;
          res.end();
          return;
        }

        if (status.state === 'failed') {
          sendEvent('failed', {
            error: status.failedReason || 'Export failed',
          });
          finished = true;
          res.end();
          return;
        }
      } catch (err: any) {
        sendEvent('error', { message: err.message });
      }

      if (!finished) {
        setTimeout(poll, pollInterval);
      }
    };

    poll();

    res.on('close', () => {
      finished = true;
    });
  }

  @Scopes('backups:read')
  @Get(':id/export/jobs/:jobId/download')
  async downloadExport(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    const file = await this.projectExport.getExportFile(id, jobId, user.sub);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    if (file.stat?.size != null) {
      res.setHeader('Content-Length', String(file.stat.size));
    }
    file.stream.pipe(res);
  }

  @Scopes('backups:read')
  @Get(':id/backups')
  async listCloudBackups(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectExport.listCloudBackups(id, user.sub);
  }

  /** Download one cloud backup (decrypted when stored encrypted) (#34). */
  @Scopes('backups:read')
  @Get(':id/backups/download')
  async downloadCloudBackup(
    @Param('id') id: string,
    @Query('objectKey') objectKey: string,
    @Query('kind') kind: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    const file = await this.projectExport.getCloudBackupFile(id, user.sub, objectKey, kind === 'auto' ? 'auto' : 'manual');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    if (file.size != null) res.setHeader('Content-Length', String(file.size));
    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  }

  /** Delete a manual export from cloud backups (#34). Nightly backups follow retention. */
  @Scopes('backups:write')
  @Delete(':id/backups')
  async deleteCloudBackup(
    @Param('id') id: string,
    @Query('objectKey') objectKey: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectExport.deleteCloudBackup(id, user.sub, objectKey);
  }

  @Scopes('backups:write')
  @Post(':id/backups/restore')
  async restoreCloudBackup(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body()
    body: {
      objectKey: string;
      teamId: string;
      nameMode?: 'existing' | 'new';
      newProjectName?: string;
      existingProjectId?: string;
      kind?: 'manual' | 'auto';
    },
  ) {
    return this.projectExport.restoreCloudBackup(id, user.sub, body);
  }

  /** What range of timestamps this project can be recovered to right now. */
  @Scopes('backups:read')
  @Get(':id/pitr/window')
  async getRecoveryWindow(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectPitr.getRecoveryWindow(id, user.sub);
  }

  /**
   * Recover the project database to an instant inside the window. The restore
   * runs as a background job: this answers 202 with the job at once, and
   * `GET :id/pitr/restore/:jobId` reports its progress (#257).
   */
  @Scopes('backups:write')
  @Post(':id/pitr/restore')
  @HttpCode(202)
  async restoreToTimestamp(
    @Param('id') id: string,
    @Body('targetTime') targetTime: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.pitrRestoreJobs.start(id, user.sub, targetTime);
  }

  /** The project's newest restore job (null when there has never been one). */
  @Scopes('backups:read')
  @Get(':id/pitr/status')
  async getPitrStatus(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.pitrRestoreJobs.latest(id, user.sub);
  }

  /** One restore job: queued, running (with its phase), succeeded or failed, and why. */
  @Scopes('backups:read')
  @Get(':id/pitr/restore/:jobId')
  async getPitrRestoreJob(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.pitrRestoreJobs.get(id, jobId, user.sub);
  }
}
