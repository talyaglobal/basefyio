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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { ProjectsService } from './projects.service';
import { SupabaseImportService } from './supabase-import.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ImportSupabaseDto } from './dto/import-supabase.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';

@Controller('projects')
@UseGuards(JwtAuthGuard)
@UseInterceptors(AuditLogInterceptor)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly supabaseImport: SupabaseImportService,
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
    );
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
    let finished = false;
    const pollInterval = 500;

    const poll = async () => {
      if (finished) return;

      try {
        const status = await this.supabaseImport.getJobStatus(jobId);

        if (!status) {
          sendEvent('error', { message: 'Job not found' });
          finished = true;
          res.end();
          return;
        }

        const progressJson = JSON.stringify(status.progress || {});
        if (progressJson !== lastProgressJson && progressJson !== '{}') {
          lastProgressJson = progressJson;
          sendEvent('progress', status.progress);
        }

        if (status.state === 'completed') {
          sendEvent('completed', {
            progress: status.result,
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
        sendEvent('error', { message: err.message });
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
    @Body() body: { folderId?: string | null; tags?: string[] },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.update(id, user.sub, body);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.remove(id, user.sub);
  }
}
