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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { StorageService } from './storage.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

@Controller('projects/:projectId/storage')
@UseGuards(JwtOrApiKeyGuard)
export class StorageController {
  constructor(private readonly storage: StorageService) {}

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
    return this.storage.createBucket(projectId, user?.sub, body.name, body.public);
  }

  @Delete('buckets/:bucketName')
  async deleteBucket(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.storage.deleteBucket(projectId, user?.sub, bucketName);
  }

  @Patch('buckets/:bucketName')
  async updateBucket(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { public: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.storage.toggleBucketPublic(projectId, user?.sub, bucketName, body.public);
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
    return this.storage.uploadObject(
      projectId,
      user?.sub,
      bucketName,
      objectPath,
      file.buffer,
      file.mimetype,
    );
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
    return this.storage.getPresignedUrl(
      projectId,
      user?.sub,
      bucketName,
      objectPath,
      expiry ? parseInt(expiry, 10) : 3600,
    );
  }

  @Delete('buckets/:bucketName/objects')
  async deleteObjects(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { paths: string[] },
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.storage.deleteObjects(projectId, user?.sub, bucketName, body.paths);
  }
}
