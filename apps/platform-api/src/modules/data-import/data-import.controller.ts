import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { DataImportService } from './data-import.service';
import { StartImportDto } from './dto/start-import.dto';

/**
 * HTTP surface for the generic CSV/XLSX → table import.
 *
 *   1. POST /:projectId/data-imports/inspect  — upload + preview + infer schema
 *   2. POST /:projectId/data-imports/jobs      — start the worker
 *   3. GET  /:projectId/data-imports/jobs/:jobId/status   — poll
 *   4. GET  /:projectId/data-imports/jobs/:jobId/events   — SSE stream
 *   5. POST /:projectId/data-imports/jobs/:jobId/cancel   — best-effort cancel
 *   6. GET  /:projectId/data-imports/jobs/:jobId/errors   — bad-rows CSV download
 *
 * Auth: JWT only. Service-role API key intentionally NOT supported here
 * because creating tables / mutating schema is a privileged operator action,
 * not a runtime app concern.
 */
@Controller('projects/:projectId/data-imports')
@UseGuards(JwtAuthGuard)
export class DataImportController {
  constructor(private readonly service: DataImportService) {}

  @Post('inspect')
  @UseInterceptors(FileInterceptor('file', { storage: undefined }))
  async inspect(
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!file) throw new BadRequestException('Missing file');
    return this.service.inspect(projectId, user.sub, {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
  }

  @Post('jobs')
  async start(
    @Param('projectId') projectId: string,
    @Body() dto: StartImportDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.start(projectId, user.sub, dto);
  }

  @Get('jobs/:jobId/status')
  async status(
    @Param('jobId') jobId: string,
  ) {
    return this.service.getJobStatus(jobId);
  }

  /**
   * Server-Sent Events stream for live progress. Mirrors the supabase-import
   * SSE pattern in projects.controller.ts so the admin-ui can reuse the same
   * EventSource handling code with minor adjustments.
   */
  @Get('jobs/:jobId/events')
  async events(
    @Param('jobId') jobId: string,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('connected', { jobId });

    let finished = false;
    let lastProgressJson = '';
    let lastState = '';

    const poll = async () => {
      if (finished) return;
      try {
        const status = await this.service.getJobStatus(jobId);
        if (status.state !== lastState) {
          lastState = status.state;
          send('state', { state: status.state });
        }
        const progressJson = JSON.stringify(status.progress || {});
        if (progressJson !== lastProgressJson && progressJson !== '{}') {
          lastProgressJson = progressJson;
          send('progress', status.progress);
        }
        if (status.state === 'completed') {
          send('completed', status.result || {});
          finished = true;
          res.end();
          return;
        }
        if (status.state === 'failed') {
          send('failed', { error: status.failedReason || 'Import failed' });
          finished = true;
          res.end();
          return;
        }
      } catch (err: any) {
        send('failed', { error: err?.message || 'Stream error' });
        finished = true;
        res.end();
        return;
      }
      if (!finished) setTimeout(poll, 500);
    };
    poll();

    res.on('close', () => {
      finished = true;
    });
  }

  @Post('jobs/:jobId/cancel')
  async cancel(
    @Param('jobId') jobId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.cancelJob(jobId, user.sub);
    return { ok: true };
  }

  @Get('jobs/:jobId/errors')
  async downloadErrors(
    @Param('jobId') jobId: string,
    @Res() res: Response,
  ) {
    const stream = await this.service.getErrorReportStream(jobId);
    if (!stream) {
      res.status(404).json({ message: 'No error report available' });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="import-${jobId}-errors.csv"`,
    );
    stream.pipe(res);
  }
}
