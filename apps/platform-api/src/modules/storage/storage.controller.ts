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
import { BucketIntent, StorageAccessService } from './storage-access.service';
import { isPrivileged, ownerMeta, storageCaller } from './storage-caller';
import {
  assertBucketName,
  cleanKey,
  limitViolation,
  pageListing,
  parseBucketLimits,
  parseListOptions,
  stringList,
} from './storage-objects';
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

/** Signed URL lifetime, in seconds. */
export const MIN_SIGNED_EXPIRY = 60;
export const MAX_SIGNED_EXPIRY = 7 * 24 * 60 * 60;
export const DEFAULT_SIGNED_EXPIRY = 3600;

/**
 * Buckets and objects.
 *
 * The controller defaults to the service key, so a route added here later is
 * closed until someone states otherwise. Carved out of that default: object
 * reads and writes need a signed-in end user, and the two routes a browser
 * reaches with no headers at all — a public file's URL and the download behind
 * it — stay open to the public key, because an <img src> cannot send an apikey
 * header.
 *
 * A private bucket is closed to the bare public key on every route, reads
 * included: it is reached with a signed-in user's token, a signed URL or the
 * service key (StorageAccessService.assertBucketReachable). A project can open
 * reads of a private bucket or prefix to the public key on purpose with a
 * `public-read` access rule, and narrow access further with the other rules
 * (StoragePolicy, administered by StoragePolicyController), which this
 * controller enforces on download, render, list, delete and overwrite.
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

  /** Refuses the bare public key on a private bucket (see the class comment). */
  private reachable(
    req: Request,
    projectId: string,
    bucketName: string,
    key: string,
    intent: BucketIntent,
    verb: string,
  ): Promise<void> {
    return this.access.assertBucketReachable(storageCaller(req), projectId, bucketName, key, intent, verb, () =>
      this.storage.isPublicBucket(projectId, bucketName),
    );
  }

  // ── Buckets ────────────────────────────────────────────

  /**
   * Every bucket of the project. The bare public key sees only the public ones:
   * a private bucket's name, size and contents are none of its business.
   */
  @Get('buckets')
  @AuthenticatedKeyOnly()
  async listBuckets(
    @Param('projectId') projectId: string,
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    const buckets = await this.storage.listBuckets(projectId, user?.sub);
    return storageCaller(req).kind === 'anon' ? buckets.filter((b) => b.public) : buckets;
  }

  /** The ceilings that apply to every upload, so a client can check before sending. */
  @Get('limits')
  @AnonKeyAllowed()
  async limits(@Param('projectId') projectId: string, @CurrentUser() user?: JwtPayload) {
    await this.storage.resolveProject(projectId, user?.sub);
    return {
      // Larger files go through upload sessions (resumable, chunked).
      maxUploadBytes,
      signedUrlExpiry: { min: MIN_SIGNED_EXPIRY, max: MAX_SIGNED_EXPIRY, default: DEFAULT_SIGNED_EXPIRY },
    };
  }

  @Post('buckets')
  async createBucket(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; public?: boolean; fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null },
    @CurrentUser() user?: JwtPayload,
  ) {
    const input = (body ?? {}) as Record<string, unknown>;
    // The store would lower-case and rewrite a name it cannot hold, and then
    // the bucket would answer to a name the caller never chose. Refuse instead.
    const name = assertBucketName(input.name);
    if (input.public !== undefined && typeof input.public !== 'boolean') {
      throw new BadRequestException('public must be true or false');
    }
    const limits = parseBucketLimits(input);
    const result = await this.storage.createBucket(projectId, user?.sub, name, input.public === true, limits);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_BUCKET_CREATED,
      title: `Storage bucket created: ${name}`,
      detail: input.public === true ? 'Public bucket' : 'Private bucket',
    });
    return result;
  }

  /**
   * Delete a bucket. One that still holds files answers 409 unless
   * `?force=true` is given, so a script cannot wipe a bucket's contents by
   * accident.
   */
  @Delete('buckets/:bucketName')
  async deleteBucket(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('force') force: string | undefined,
    @CurrentUser() user?: JwtPayload,
  ) {
    const forced = force === 'true' || force === '1';
    if (force !== undefined && !forced && force !== 'false' && force !== '0') {
      throw new BadRequestException('force must be true or false');
    }
    const result = await this.storage.deleteBucket(projectId, user?.sub, bucketName, { force: forced });
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_BUCKET_DELETED,
      title: `Storage bucket deleted: ${bucketName}`,
      ...(result.deletedObjects ? { detail: `${result.deletedObjects} file(s) deleted with it` } : {}),
    });
    return result;
  }

  /**
   * Change a bucket's visibility and/or its upload limits. Every field is
   * optional, but the body must change something and each field must have its
   * type: `public` is a boolean, never a string that happens to be truthy.
   */
  @Patch('buckets/:bucketName')
  async updateBucket(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { public?: boolean; fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null },
    @CurrentUser() user?: JwtPayload,
  ) {
    const input = (body ?? {}) as Record<string, unknown>;
    if (input.public !== undefined && typeof input.public !== 'boolean') {
      throw new BadRequestException('public must be true or false');
    }
    const limits = parseBucketLimits(input);
    if (input.public === undefined && Object.keys(limits).length === 0) {
      throw new BadRequestException('Nothing to update: send public, fileSizeLimit and/or allowedMimeTypes');
    }

    const out: Record<string, unknown> = {};
    if (input.public !== undefined) {
      const result = await this.storage.toggleBucketPublic(projectId, user?.sub, bucketName, input.public as boolean);
      Object.assign(out, result);
      await this.activity.append(projectId, {
        userId: user?.sub,
        kind: ProjectActivityKind.STORAGE_BUCKET_UPDATED,
        title: `Storage bucket visibility updated: ${bucketName}`,
        detail: input.public ? 'Set public' : 'Set private',
      });
    }
    if (Object.keys(limits).length > 0) {
      await this.storage.resolveBucket(projectId, user?.sub, bucketName);
      Object.assign(out, await this.storage.setBucketLimits(projectId, bucketName, limits));
      await this.activity.append(projectId, {
        userId: user?.sub,
        kind: ProjectActivityKind.STORAGE_BUCKET_UPDATED,
        title: `Storage bucket upload limits updated: ${bucketName}`,
      });
    }
    return out;
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
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.reachable(req, projectId, bucketName, String(body?.path ?? ''), 'write', 'create folders in');
    const result = await this.storage.createFolder(projectId, user?.sub, bucketName, body?.path);
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
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    const paths = stringList(body?.paths, 'paths');
    await this.reachable(req, projectId, bucketName, '', 'read', 'look into');
    const existing = await this.storage.findExistingObjects(projectId, user?.sub, bucketName, paths);
    return { existing };
  }

  @Post('buckets/:bucketName/objects/move')
  @AuthenticatedKeyOnly()
  async moveObjects(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { sources: string[]; destFolder?: string },
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    // An empty or malformed body used to answer 201 { moved: 0 }, which reads
    // as success. Say what is wrong instead.
    const sources = stringList(body?.sources, 'sources');
    if (body?.destFolder !== undefined && body.destFolder !== null && typeof body.destFolder !== 'string') {
      throw new BadRequestException('destFolder must be a string (blank = the bucket root)');
    }
    await this.reachable(req, projectId, bucketName, '', 'write', 'move files in');
    await this.access.assertCanModifyAll(
      storageCaller(req),
      projectId,
      bucketName,
      sources,
      this.statFn(projectId, user?.sub, bucketName),
      'move',
    );
    const result = await this.storage.moveObjects(projectId, user?.sub, bucketName, sources, body.destFolder || '');
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_OBJECT_UPLOADED,
      title: `Storage items moved: ${bucketName}`,
      detail: `${result.moved} item(s) → ${body.destFolder || '/'}`,
    });
    return result;
  }

  /**
   * Copy a file or a folder (a path ending in '/') to a new path in the same
   * bucket. `{ from, to, overwrite? }` → `{ from, to, count }`; 409 when the
   * destination exists and `overwrite` is not set.
   */
  @Post('buckets/:bucketName/objects/copy')
  @AuthenticatedKeyOnly()
  async copyObject(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { from: string; to: string; overwrite?: boolean },
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.copyOrRename(projectId, bucketName, body, req, user, false);
  }

  /**
   * Rename (move) a file or a folder to a new path in the same bucket. Same
   * body and answer as copy; the source is gone afterwards.
   */
  @Post('buckets/:bucketName/objects/rename')
  @AuthenticatedKeyOnly()
  async renameObject(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { from: string; to: string; overwrite?: boolean },
    @Req() req: Request,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.copyOrRename(projectId, bucketName, body, req, user, true);
  }

  private async copyOrRename(
    projectId: string,
    bucketName: string,
    body: { from: string; to: string; overwrite?: boolean } | undefined,
    req: Request,
    user: JwtPayload | undefined,
    move: boolean,
  ) {
    const from = cleanKey(body?.from, 'from');
    const to = cleanKey(body?.to, 'to');
    if (body?.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
      throw new BadRequestException('overwrite must be true or false');
    }
    await this.reachable(req, projectId, bucketName, from, 'write', move ? 'rename files in' : 'copy files in');

    const caller = storageCaller(req);
    const statFn = this.statFn(projectId, user?.sub, bucketName);
    if (move) {
      await this.access.assertCanModifyAll(caller, projectId, bucketName, [from], statFn, 'move');
    } else {
      const mode = await this.access.resolveMode(projectId, bucketName, from);
      if (mode && !isPrivileged(caller)) {
        if (from.endsWith('/') && mode === 'owner-only') {
          throw new BadRequestException(`"${from}" is a folder in an owner-only location; copy its files individually.`);
        }
        this.access.assertCanRead(caller, mode, mode === 'owner-only' ? await statFn(from) : null, from);
      }
    }
    // Writing over an object counts as touching it, as on upload.
    const destMode = await this.access.resolveMode(projectId, bucketName, to);
    if (destMode === 'owner-only' && !isPrivileged(caller) && body?.overwrite) {
      this.access.assertCanOverwrite(caller, destMode, await statFn(to), to);
    }

    const result = await this.storage.copyObjects(projectId, user?.sub, bucketName, from, to, {
      overwrite: body?.overwrite === true,
      move,
    });
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_OBJECT_UPLOADED,
      title: `Storage ${move ? 'item renamed' : 'item copied'}: ${bucketName}`,
      detail: `${from} → ${to}`,
    });
    return move ? { from: result.from, to: result.to, moved: result.count } : { ...result, copied: result.count };
  }

  /**
   * One level of a bucket (`prefix`), or everything under it with
   * `recursive=true`. Optional `search` (substring of the entry's own name),
   * `sortBy` (name | size | lastModified), `order` (asc | desc), `limit`
   * (≤ 1000) and `offset`; folders come before files whenever a sort is asked
   * for. The answer is the same array as always, sliced to the page; the
   * number of matching entries travels in `X-Total-Count`.
   */
  @Get('buckets/:bucketName/objects')
  @AuthenticatedKeyOnly()
  async listObjects(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res?: Response,
    @CurrentUser() user?: JwtPayload,
  ) {
    const prefix = typeof query?.prefix === 'string' ? query.prefix : '';
    const recursive = query?.recursive === 'true' || query?.recursive === '1';
    const opts = parseListOptions(query ?? {});
    await this.reachable(req, projectId, bucketName, prefix, 'read', 'list');
    const objects = await this.storage.listObjects(projectId, user?.sub, bucketName, prefix, recursive);
    const mode = await this.access.resolveMode(projectId, bucketName, prefix);
    const visible = await this.access.filterListing(
      storageCaller(req),
      mode,
      objects,
      this.statFn(projectId, user?.sub, bucketName),
    );
    const { items, total } = pageListing(visible, opts);
    res?.setHeader?.('X-Total-Count', String(total));
    return items;
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
      const key = objectPath.replace(/^\/+/, '');
      if (!key || key.endsWith('/') || key.split('/').some((seg) => seg === '..') || key.includes('\0')) {
        throw new BadRequestException('path must name a file inside the bucket');
      }
      await this.reachable(req, projectId, bucketName, key, 'write', 'upload to');

      const violation = limitViolation(
        await this.storage.getBucketLimits(projectId, bucketName),
        bucketName,
        file.size,
        file.mimetype,
      );
      if (violation) {
        throw violation.status === 413
          ? new PayloadTooLargeException(violation.message)
          : new UnsupportedMediaTypeException(violation.message);
      }

      // Writing over someone else's object counts as touching it.
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
    // Before the object is opened: a refused caller must not learn whether it exists.
    await this.reachable(req, projectId, bucketName, objectPath || '', 'read', 'download from');
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
    await this.reachable(req, projectId, bucketName, objectPath || '', 'read', 'read images from');
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
    const expirySeconds = expiry ? Number(expiry) : DEFAULT_SIGNED_EXPIRY;
    if (!Number.isInteger(expirySeconds) || expirySeconds < MIN_SIGNED_EXPIRY || expirySeconds > MAX_SIGNED_EXPIRY) {
      throw new BadRequestException(
        `Expiry must be a whole number of seconds between ${MIN_SIGNED_EXPIRY} and ${MAX_SIGNED_EXPIRY}`,
      );
    }
    // Minting a URL is a read: whoever may not read the object may not hand it out.
    await this.reachable(req, projectId, bucketName, objectPath || '', 'read', 'create signed URLs for');
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
    const paths = stringList(body?.paths, 'paths');
    await this.reachable(req, projectId, bucketName, '', 'write', 'delete files in');
    await this.access.assertCanModifyAll(
      storageCaller(req),
      projectId,
      bucketName,
      paths,
      this.statFn(projectId, user?.sub, bucketName),
      'delete',
    );
    const result = await this.storage.deleteObjects(projectId, user?.sub, bucketName, paths);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_OBJECT_DELETED,
      title: `Storage object(s) deleted: ${bucketName}`,
      detail: `${result.deleted.length} object(s)`,
      metadata: { paths: paths.slice(0, 20) },
    });
    return result;
  }
}
