import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Head,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CHUNK_CONTENT_TYPE,
  CreateUploadSessionInput,
  MAX_CHUNK_BYTES,
  UploadOffsetMismatchException,
  UploadSessionService,
  UploadSessionView,
  readRawBody,
} from './upload-session.service';
import { storageCaller } from './storage-caller';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { AuthenticatedKeyOnly, ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { ProjectActivityKind, ProjectActivityService } from '../projects/project-activity.service';

/**
 * Resumable uploads.
 *
 *   POST   upload-sessions                 { path, size, contentType?, chunkSize? } → session
 *   GET    upload-sessions/:id             → session (also Upload-Offset / Upload-Length headers)
 *   HEAD   upload-sessions/:id             → headers only
 *   PATCH  upload-sessions/:id             Upload-Offset header + raw chunk body → session (new offset)
 *   POST   upload-sessions/:id/complete    → the stored object
 *   DELETE upload-sessions/:id             → { id, status: 'aborted' }
 *
 * The header names follow the tus vocabulary so existing clients feel at home,
 * but this is not a tus-conformant server: there is no protocol negotiation and
 * no extension support. Every response carries a JSON body (no 204): the
 * dashboard reaches the API through a proxy that forwards bodies, not headers.
 */
@Controller('projects/:projectId/storage/buckets/:bucketName/upload-sessions')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class UploadSessionController {
  constructor(
    private readonly sessions: UploadSessionService,
    private readonly activity: ProjectActivityService,
  ) {}

  private sessionHeaders(res: Response, view: UploadSessionView): void {
    res.set({
      'Upload-Offset': String(view.offset),
      'Upload-Length': String(view.size),
      'Cache-Control': 'no-store',
    });
  }

  @Post()
  @AuthenticatedKeyOnly()
  @HttpCode(201)
  async create(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: CreateUploadSessionInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ): Promise<UploadSessionView> {
    const view = await this.sessions.createUploadSession(projectId, storageCaller(req), user?.sub, bucketName, body);
    this.sessionHeaders(res, view);
    return view;
  }

  @Get(':sessionId')
  @AuthenticatedKeyOnly()
  async get(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ): Promise<UploadSessionView> {
    const view = await this.sessions.getSession(projectId, storageCaller(req), user?.sub, bucketName, sessionId);
    this.sessionHeaders(res, view);
    return view;
  }

  @Head(':sessionId')
  @AuthenticatedKeyOnly()
  async head(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user?: JwtPayload,
  ): Promise<void> {
    const view = await this.sessions.getSession(projectId, storageCaller(req), user?.sub, bucketName, sessionId);
    this.sessionHeaders(res, view);
    res.status(200).end();
  }

  @Patch(':sessionId')
  @AuthenticatedKeyOnly()
  async append(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Param('sessionId') sessionId: string,
    @Headers('upload-offset') offsetHeader: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ): Promise<UploadSessionView> {
    const type = (contentType || '').split(';')[0].trim().toLowerCase();
    if (type !== CHUNK_CONTENT_TYPE && type !== 'application/octet-stream') {
      throw new UnsupportedMediaTypeException(`Send chunks as ${CHUNK_CONTENT_TYPE}`);
    }
    if (offsetHeader === undefined || offsetHeader === '' || !/^\d+$/.test(offsetHeader.trim())) {
      throw new BadRequestException('Upload-Offset header is required and must be a non-negative integer');
    }
    const offset = Number(offsetHeader.trim());
    const body = await readRawBody(req, MAX_CHUNK_BYTES);

    try {
      const view = await this.sessions.appendChunk(
        projectId,
        storageCaller(req),
        user?.sub,
        bucketName,
        sessionId,
        offset,
        body,
      );
      this.sessionHeaders(res, view);
      return view;
    } catch (err) {
      // Tell the client where the server really is so it can resume.
      if (err instanceof UploadOffsetMismatchException) res.set('Upload-Offset', String(err.offset));
      throw err;
    }
  }

  @Post(':sessionId/complete')
  @AuthenticatedKeyOnly()
  async complete(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.sessions.complete(projectId, storageCaller(req), user?.sub, bucketName, sessionId);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_OBJECT_UPLOADED,
      title: `Storage object uploaded: ${bucketName}`,
      detail: result.name,
      metadata: { size: result.size, contentType: result.contentType, resumable: true },
    });
    return result;
  }

  @Delete(':sessionId')
  @AuthenticatedKeyOnly()
  async abort(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ): Promise<{ id: string; status: 'aborted' }> {
    await this.sessions.abort(projectId, storageCaller(req), user?.sub, bucketName, sessionId);
    return { id: sessionId, status: 'aborted' };
  }
}
