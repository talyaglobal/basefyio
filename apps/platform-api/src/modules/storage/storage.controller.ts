import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  Req,
  Res,
  Headers,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  BadRequestException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { StorageService } from './storage.service';
import { ImageTransformService } from './image-transform.service';
import { StorageAccessService } from './storage-access.service';
import { isPrivileged, ownerMeta, storageCaller } from './storage-caller';
import {
  ContentLengthGuard,
  Semaphore,
  removeSpooled,
  resolveMaxConcurrentUploads,
  resolveMaxUploadBytes,
  spoolMulterOptions,
} from './upload-spool';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  AnonKeyAllowed,
  AuthenticatedKeyOnly,
  ServiceKeyOnly,
} from '../../common/decorators/api-key-scope.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';

/**
 * Default ceiling for a single-request upload; STORAGE_MAX_UPLOAD_MB overrides
 * it at boot. The body is spooled to disk and streamed to the store, so the
 * figure is bounded by scratch disk rather than by the API's heap.
 */
export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const maxUploadBytes = resolveMaxUploadBytes(MAX_FILE_SIZE);
/** Uploads streaming to the store at once on this instance; beyond it the route answers 503. */
const uploadSlots = new Semaphore(resolveMaxConcurrentUploads());

/**
 * Buckets and objects.
 *
 * The controller defaults to the service key, so a route added here later is
 * closed until someone states otherwise. Carved out of that default: object
 * reads and writes need a signed-in end user, and the two routes a browser
 * reaches with no headers at all — a public file's URL and the download behind
 * it — stay public, because an <img src> cannot send an apikey header.
 *
 * By default a private bucket is still readable by anyone holding the public
 * key through the download route. A project closes that per bucket or prefix
 * with an access rule (StoragePolicy, administered by StoragePolicyController)
 * which this controller enforces on download, render, list, delete and
 * overwrite. With no rule, nothing here changes.
 */
@Controller('projects/:projectId/storage')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class StorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly activity: ProjectActivityService,
    private readonly transforms: ImageTransformService,
    private readonly access: StorageAccessService,
  ) {}

  /** `statObject` for access checks, resolving the physical bucket once per request. */
  private statFn(projectId: string, userId: string | undefined, bucketName: string) {
    let physical: string | undefined;
    return async (key: string) => {
      physical ??= (await this.storage.resolveBucket(projectId, userId, bucketName)).minioBucket;
      return this.storage.statObjectIn(physical, key);
    };
  }

  // ── Buckets ────────────────────────────────────────────

  @Get('buckets')
  @AuthenticatedKeyOnly()
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

  @Get('buckets/:bucketName/public-url')
  @AnonKeyAllowed()
  async getPublicUrl(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') path: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.storage.getPublicUrl(projectId, user?.sub, bucketName, path || '');
  }

  // ── Folders & Objects ──────────────────────────────────

  @Post('buckets/:bucketName/folders')
  @AuthenticatedKeyOnly()
  async createFolder(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { path: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.storage.createFolder(projectId, user?.sub, bucketName, body.path);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_OBJECT_UPLOADED,
      title: `Storage folder created: ${bucketName}`,
      detail: result.name,
    });
    return result;
  }

  @Post('buckets/:bucketName/objects/exists')
  @AuthenticatedKeyOnly()
  async findExisting(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { paths: string[] },
    @CurrentUser() user?: JwtPayload,
  ) {
    const existing = await this.storage.findExistingObjects(
      projectId,
      user?.sub,
      bucketName,
      body.paths || [],
    );
    return { existing };
  }

  @Post('buckets/:bucketName/objects/move')
  @AuthenticatedKeyOnly()
  async moveObjects(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { sources: string[]; destFolder: string },
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.access.assertCanModifyAll(
      storageCaller(req),
      projectId,
      bucketName,
      body.sources || [],
      this.statFn(projectId, user?.sub, bucketName),
      'move',
    );
    const result = await this.storage.moveObjects(
      projectId,
      user?.sub,
      bucketName,
      body.sources || [],
      body.destFolder || '',
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_OBJECT_UPLOADED,
      title: `Storage items moved: ${bucketName}`,
      detail: `${result.moved} item(s) → ${body.destFolder || '/'}`,
    });
    return result;
  }

  @Get('buckets/:bucketName/objects')
  @AuthenticatedKeyOnly()
  async listObjects(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('prefix') prefix: string,
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    const objects = await this.storage.listObjects(projectId, user?.sub, bucketName, prefix || '');
    const mode = await this.access.resolveMode(projectId, bucketName, prefix || '');
    return this.access.filterListing(
      storageCaller(req),
      mode,
      objects,
      this.statFn(projectId, user?.sub, bucketName),
    );
  }

  // The body lands in a disk spool (multer stops reading at the limit, which
  // Nest reports as 413) and is streamed to the store from there, so a large
  // upload costs scratch disk for a few seconds instead of heap. The guard
  // refuses a hopeless Content-Length before any byte is written.
  @Post('buckets/:bucketName/objects')
  @AuthenticatedKeyOnly()
  @UseGuards(new ContentLengthGuard(maxUploadBytes))
  @UseInterceptors(FileInterceptor('file', spoolMulterOptions(maxUploadBytes)))
  async uploadObject(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') filePath: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: maxUploadBytes })],
        fileIsRequired: true,
      }),
    )
    file: Express.Multer.File,
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    const objectPath = filePath || file.originalname;
    const caller = storageCaller(req);

    const release = uploadSlots.tryAcquire();
    if (!release) {
      await removeSpooled(file.path);
      throw new ServiceUnavailableException('Too many uploads in progress, retry shortly');
    }
    try {
      // Writing over someone else's object counts as touching it.
      const key = objectPath.replace(/^\/+/, '');
      const mode = await this.access.resolveMode(projectId, bucketName, key);
      if (mode === 'owner-only' && !isPrivileged(caller)) {
        const existing = await this.statFn(projectId, user?.sub, bucketName)(key);
        this.access.assertCanOverwrite(caller, mode, existing, key);
      }

      const uploaded = await this.storage.uploadObjectStream(
        projectId,
        user?.sub,
        bucketName,
        objectPath,
        createReadStream(file.path),
        file.size,
        file.mimetype,
        ownerMeta(caller),
      );
      await this.activity.append(projectId, {
        userId: user?.sub,
        kind: ProjectActivityKind.STORAGE_OBJECT_UPLOADED,
        title: `Storage object uploaded: ${bucketName}`,
        detail: objectPath,
        metadata: { size: file.size, contentType: file.mimetype },
      });
      return uploaded;
    } finally {
      release();
      await removeSpooled(file.path);
    }
  }

  // A browser loads a file through an <img>, <video> or <a download>, none of
  // which can set an apikey header, so this route is the one that stays open to
  // the public key. It is what getPublicUrl() points at.
  @Get('buckets/:bucketName/objects/download')
  @AnonKeyAllowed()
  async downloadObject(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') objectPath: string,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload | undefined,
    @Res() res: Response,
  ) {
    const { stream, stat } = await this.storage.getObject(
      projectId,
      user?.sub,
      bucketName,
      objectPath,
    );
    await this.assertReadable(req, projectId, bucketName, objectPath, stat, stream);

    const fileName = objectPath.split('/').pop() || 'download';
    const encodedName = encodeURIComponent(fileName);

    res.set({
      'Content-Type': stat.metaData?.['content-type'] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
    });

    stream.pipe(res);
  }

  // Resize and re-encode an image on the way out. Reachable like the download
  // route, for the same reason: an <img src> cannot send headers. Only image
  // sources are accepted and the output is bounded by ImageTransformService's
  // limits; a matching If-None-Match answers 304 without touching the pixels.
  @Get('buckets/:bucketName/objects/render')
  @AnonKeyAllowed()
  async renderObject(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') objectPath: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload | undefined,
    @Res() res: Response,
  ) {
    if (!this.transforms.available()) {
      throw new NotImplementedException('Image transforms are not available on this build');
    }
    const opts = this.transforms.parseTransformQuery(query || {});
    const { stream, stat } = await this.storage.getObject(
      projectId,
      user?.sub,
      bucketName,
      objectPath,
    );
    // Before the ETag check: a refused caller must not learn whether its cached copy is current.
    await this.assertReadable(req, projectId, bucketName, objectPath, stat, stream);

    const cacheControl = `public, max-age=${this.transforms.limits.cacheSeconds}`;
    const etag = this.transforms.etagFor(stat.etag, opts);
    if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
      stream.destroy();
      res.status(304).set({ ETag: etag, 'Cache-Control': cacheControl }).end();
      return;
    }

    const sourceType = stat.metaData?.['content-type'] || 'application/octet-stream';
    const check = this.transforms.isTransformableSource(sourceType, stat.size);
    if (!check.ok) {
      stream.destroy();
      if (check.reason === 'type') {
        throw new UnsupportedMediaTypeException(
          `"${objectPath}" is not an image that can be transformed (${sourceType})`,
        );
      }
      const mb = Math.floor(this.transforms.limits.maxSourceBytes / (1024 * 1024));
      throw new PayloadTooLargeException(`Source image exceeds the ${mb} MB transform limit`);
    }

    const release = this.transforms.tryAcquire();
    if (!release) {
      stream.destroy();
      res.set('Retry-After', '2');
      throw new ServiceUnavailableException('Too many image transforms in progress, retry shortly');
    }

    const { stream: out, contentType, format } = this.transforms.transform(stream, sourceType, opts);
    const baseName = (objectPath.split('/').pop() || 'image').replace(/\.[^.]*$/, '');
    const encodedName = encodeURIComponent(`${baseName}.${format === 'jpeg' ? 'jpg' : format}`);

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': cacheControl,
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    });
    res.once('close', release);
    out.once('error', (err: Error) => {
      release();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      for (const h of ['Content-Disposition', 'Cache-Control', 'ETag']) res.removeHeader(h);
      res
        .status(422)
        .type('application/json')
        .send({ statusCode: 422, message: `Unprocessable image: ${err.message}` });
    });
    out.pipe(res);
  }

  /**
   * Access-rule check shared by download and render. A no-op when the bucket
   * has no rule; otherwise the object's stream is closed before refusing.
   */
  private async assertReadable(
    req: Request,
    projectId: string,
    bucketName: string,
    objectPath: string,
    stat: { metaData?: Record<string, unknown> },
    stream: { destroy: (err?: Error) => unknown },
  ): Promise<void> {
    const mode = await this.access.resolveMode(projectId, bucketName, objectPath);
    if (!mode) return;
    try {
      this.access.assertCanRead(storageCaller(req), mode, stat, objectPath);
    } catch (err) {
      stream.destroy();
      throw err;
    }
  }

  @Get('buckets/:bucketName/objects/url')
  @AuthenticatedKeyOnly()
  async getPresignedUrl(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') objectPath: string,
    @Query('expiry') expiry: string,
    @Req() req: Request,
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
    // A signed URL bypasses every later check, so the rule is applied when it is minted.
    const caller = storageCaller(req);
    const mode = await this.access.resolveMode(projectId, bucketName, objectPath);
    if (mode && !isPrivileged(caller)) {
      const stat = mode === 'owner-only' ? await this.statFn(projectId, user?.sub, bucketName)(objectPath) : null;
      this.access.assertCanRead(caller, mode, stat, objectPath);
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
  @AuthenticatedKeyOnly()
  async deleteObjects(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { paths: string[] },
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.access.assertCanModifyAll(
      storageCaller(req),
      projectId,
      bucketName,
      body.paths || [],
      this.statFn(projectId, user?.sub, bucketName),
      'delete',
    );
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
