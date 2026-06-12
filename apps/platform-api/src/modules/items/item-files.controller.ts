import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseInterceptors,
  UploadedFile,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ItemFilesService } from './item-files.service';

@Controller('v1/projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
export class ItemFilesController {
  constructor(private readonly service: ItemFilesService) {}

  @Post('items/:entityName/:itemId/files')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  upload(
    @Param('projectId') projectId: string,
    @Param('entityName') entityName: string,
    @Param('itemId') itemId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.service.uploadFile(projectId, entityName, itemId, {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    });
  }

  @Get('items/:entityName/:itemId/files')
  listFiles(
    @Param('projectId') projectId: string,
    @Param('entityName') entityName: string,
    @Param('itemId') itemId: string,
  ) {
    return this.service.listFiles(projectId, entityName, itemId);
  }

  @Get('files/:fileId')
  async download(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ) {
    const { stream, metadata } = await this.service.getFileStream(projectId, fileId);
    res.setHeader('Content-Type', metadata.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(metadata.filename)}"`,
    );
    res.setHeader('Content-Length', String(metadata.size));
    (stream as NodeJS.ReadableStream).pipe(res);
  }

  @Delete('files/:fileId')
  @HttpCode(HttpStatus.OK)
  deleteFile(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
  ) {
    return this.service.deleteFile(projectId, fileId);
  }
}
