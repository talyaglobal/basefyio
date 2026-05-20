import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { StorageService } from './storage.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

@Controller('projects/:projectId/storage')
@UseGuards(JwtOrApiKeyGuard)
export class StorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly activity: ProjectActivityService,
  ) {}

  // ── Buckets ────────────────────────────────────────────

  @Get('buckets')
  async listBuckets(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.storage.listBuckets(projectId, user?.sub);
  }

  @Post('buckets')
  async createBucket(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; public?: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.storage.createBucket(projectId, user?.sub, body.name, body.public);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_BUCKET_CREATED,
      title: `Storage bucket created: ${body.name}`,
      detail: body.public ? 'Public bucket' : 'Private bucket',
    });
    return result;
  }

  @Delete('buckets/:bucketName')
  async deleteBucket(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.storage.deleteBucket(projectId, user?.sub, bucketName);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_BUCKET_DELETED,
      title: `Storage bucket deleted: ${bucketName}`,
    });
    return result;
  }

  @Patch('buckets/:bucketName')
  async updateBucket(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { public: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.storage.toggleBucketPublic(projectId, user?.sub, bucketName, body.public);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_BUCKET_UPDATED,
      title: `Storage bucket visibility updated: ${bucketName}`,
      detail: body.public ? 'Set public' : 'Set private',
    });
    return result;
  }

  // ── Objects ────────────────────────────────────────────

  @Get('buckets/:bucketName/objects')
  async listObjects(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('prefix') prefix: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.storage.listObjects(projectId, user?.sub, bucketName, prefix || '');
  }

  @Post('buckets/:bucketName/objects')
  @UseInterceptors(FileInterceptor('file'))
  async uploadObject(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') filePath: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: MAX_FILE_SIZE })],
        fileIsRequired: true,
      }),
    )
    file: Express.Multer.File,
    @CurrentUser() user?: JwtPayload,
  ) {
    const objectPath = filePath || file.originalname;
    const uploaded = await this.storage.uploadObject(
      projectId,
      user?.sub,
      bucketName,
      objectPath,
      file.buffer,
      file.mimetype,
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_OBJECT_UPLOADED,
      title: `Storage object uploaded: ${bucketName}`,
      detail: objectPath,
      metadata: { size: file.size, contentType: file.mimetype },
    });
    return uploaded;
  }

  @Get('buckets/:bucketName/objects/download')
  async downloadObject(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') objectPath: string,
    @CurrentUser() user: JwtPayload | undefined,
    @Res() res: Response,
  ) {
    const { stream, stat } = await this.storage.getObject(
      projectId,
      user?.sub,
      bucketName,
      objectPath,
    );

    const fileName = objectPath.split('/').pop() || 'download';
    const encodedName = encodeURIComponent(fileName);

    res.set({
      'Content-Type': stat.metaData?.['content-type'] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
    });

    stream.pipe(res);
  }

  @Get('buckets/:bucketName/objects/url')
  async getPresignedUrl(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') objectPath: string,
    @Query('expiry') expiry: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const MAX_EXPIRY = 7 * 24 * 60 * 60; // 7 days
    const MIN_EXPIRY = 60; // 1 minute
    let expirySeconds = expiry ? parseInt(expiry, 10) : 3600;
    if (isNaN(expirySeconds) || expirySeconds < MIN_EXPIRY || expirySeconds > MAX_EXPIRY) {
      throw new BadRequestException(
        `Expiry must be between ${MIN_EXPIRY} and ${MAX_EXPIRY} seconds`,
      );
    }
    return this.storage.getPresignedUrl(
      projectId,
      user?.sub,
      bucketName,
      objectPath,
      expirySeconds,
    );
  }

  @Delete('buckets/:bucketName/objects')
  async deleteObjects(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { paths: string[] },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.storage.deleteObjects(projectId, user?.sub, bucketName, body.paths);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_OBJECT_DELETED,
      title: `Storage object(s) deleted: ${bucketName}`,
      detail: `${body.paths.length} path(s)`,
      metadata: { paths: body.paths.slice(0, 20) },
    });
    return result;
  }
}
