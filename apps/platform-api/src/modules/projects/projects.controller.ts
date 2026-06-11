import {
  Controller,
  Get,
  Post,
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
import { CreateProjectDto } from './dto/create-project.dto';
import { ImportSupabaseDto } from './dto/import-supabase.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { ProjectActivityService } from './project-activity.service';
import { ProjectArchiveImportService } from './project-archive-import.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly supabaseImport: SupabaseImportService,
    private readonly projectExport: ProjectExportService,
    private readonly projectArchiveImport: ProjectArchiveImportService,
    private readonly projectActivity: ProjectActivityService,
  ) {}

  @Post()
  async create(
    @Body() body: CreateProjectDto & { teamId: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.create(body, user.sub);
  }

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
    );
  }

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
    },
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.projectArchiveImport.importArchive(file, user.sub, body);
  }

  @Post('import-supabase/validate')
  async validateSupabase(
    @Body() body: { supabaseUrl: string; serviceRoleKey: string },
  ) {
    return this.supabaseImport.validateAndGetInfo(
      body.supabaseUrl,
      body.serviceRoleKey,
    );
  }

  @Post('import-supabase/jobs/:jobId/cancel')
  async cancelImport(
    @Param('jobId') jobId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.supabaseImport.cancelImport(jobId, user.sub);
  }

  @Get('import-supabase/jobs/:jobId/status')
  async getJobStatus(@Param('jobId') jobId: string) {
    const status = await this.supabaseImport.getJobStatus(jobId);
    if (!status) {
      return { error: 'Job not found' };
    }
    return status;
  }

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

  @Get()
  async findAll(
    @Query('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.findAll(teamId, user.sub);
  }

  @Get('deleted')
  async findDeleted(
    @Query('teamId') teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.findDeleted(teamId, user.sub);
  }

  @Get('deletion-reasons')
  async listDeletionReasons(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    return this.projectsService.listDeletionReasons(user.sub, limit);
  }

  @Get(':id/activity')
  async listProjectActivity(
    @Param('id') id: string,
    @Query('limit') limitRaw: string | undefined,
    @Query('page') pageRaw: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const page = pageRaw ? parseInt(pageRaw, 10) : undefined;
    return this.projectActivity.listForProject(id, user.sub, { limit, page });
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.findOne(id, user.sub);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { folderId?: string | null; tags?: string[]; name?: string; description?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.update(id, user.sub, body);
  }

  @Post(':id/move-to-team')
  async moveToTeam(
    @Param('id') id: string,
    @Body('teamId') targetTeamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.moveToTeam(id, targetTeamId, user.sub);
  }

  @Patch(':id/db-password')
  async rotateDbPassword(
    @Param('id') id: string,
    @Body() body: { password?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.rotateDatabasePassword(id, user.sub, body.password);
  }

  /**
   * (Re)apply the RLS bootstrap (anon/authenticated/service_role roles, auth.*
   * helpers, default-privilege grants) to this project's database. Idempotent;
   * use to recover legacy projects whose data API returns
   * "permission denied to set role anon" / "service_role".
   */
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
  @Get(':id/rls-diagnose')
  async diagnoseRls(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.projectsService.findOne(id, user.sub);
    return this.projectsService.diagnoseRls(id);
  }

  @Post(':id/restore')
  async restore(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.restore(id, user.sub);
  }

  @Delete(':id/permanent')
  async permanentDelete(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.permanentDelete(id, user.sub);
  }

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

  @Get(':id/backups')
  async listCloudBackups(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectExport.listCloudBackups(id, user.sub);
  }

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
    },
  ) {
    return this.projectExport.restoreCloudBackup(id, user.sub, body);
  }
}
