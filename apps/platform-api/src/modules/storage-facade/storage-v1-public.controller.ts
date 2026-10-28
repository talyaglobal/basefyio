import {
  Controller,
  Get,
  Headers,
  Param,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ContentLengthGuard, Semaphore, resolveMaxConcurrentUploads, resolveMaxUploadBytes } from '../storage/upload-spool';
import { MAX_FILE_SIZE } from '../storage/storage.controller';
import { ProjectWakeService } from './project-wake.service';
import { FacadeProject, StorageFacadeService } from './storage-facade.service';
import { StorageFacadeError, SupabaseStorageExceptionFilter } from './storage-facade.errors';
import { normaliseBucketName, transformOptionsFromQuery, wildcardKey } from './storage-facade.util';
import { uploadInputFrom } from './storage-upload';
import { SpooledUpload, StorageMultipartInterceptor } from './storage-multipart.interceptor';

const maxUploadBytes = resolveMaxUploadBytes(MAX_FILE_SIZE);
const uploadSlots = new Semaphore(resolveMaxConcurrentUploads());

/**
 * The storage routes a browser reaches with no headers at all: a public
 * bucket's files (`getPublicUrl`), signed download URLs and signed upload
 * URLs. No API key, so the project comes from the `/api/p/<projectId>/`
 * prefix (supabase-paths.middleware rewrites it into the `x-bf-project` header,
 * and into `x-project-id` so the usage middleware bills the bytes) or from the
 * signed token itself, and a deactivated project is woken here the way the
 * key guard would have.
 *
 * Registered before StorageV1Controller so `object/public/…`,
 * `object/sign/…` and `object/upload/sign/…` are matched before
 * `object/:bucket/*` could take `public`, `sign` or `upload` for a bucket.
 */
@Controller('storage/v1')
@SkipThrottle()
@UseFilters(SupabaseStorageExceptionFilter)
export class StorageV1PublicController {
  constructor(
    private readonly facade: StorageFacadeService,
    private readonly wake: ProjectWakeService,
  ) {}

  @Get('object/public/:bucket/:path(*)')
  async publicObject(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    const project = await this.projectFromRef(req);
    const key = wildcardKey(req);
    const physical = await this.facade.publicBucket(project, normaliseBucketName(bucket));
    const source = await this.facade.openIn(physical, key, req.headers.range as string | undefined);
    this.facade.pipeBytes(res, source, key, download === undefined ? undefined : download || true);
  }

  @Get('render/image/public/:bucket/:path(*)')
  async publicRender(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    const project = await this.projectFromRef(req);
    const key = wildcardKey(req);
    const physical = await this.facade.publicBucket(project, normaliseBucketName(bucket));
    const source = await this.facade.openIn(physical, key);
    this.facade.pipeImage(res, source, key, transformOptionsFromQuery(query ?? {}), ifNoneMatch);
  }

  @Get('object/sign/:bucket/:path(*)')
  async signedObject(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Query('token') token: string | undefined,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    const key = wildcardKey(req);
    const bucketName = normaliseBucketName(bucket);
    const project = await this.projectFromToken(req, token);
    this.facade.signer.verify(token as string, project, 'download', bucketName, key);
    const physical = await this.facade.physicalBucket(project, bucketName);
    const source = await this.facade.openIn(physical, key, req.headers.range as string | undefined);
    this.facade.pipeBytes(res, source, key, download === undefined ? undefined : download || true);
  }

  @Get('render/image/sign/:bucket/:path(*)')
  async signedRender(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Query('token') token: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    const key = wildcardKey(req);
    const bucketName = normaliseBucketName(bucket);
    const project = await this.projectFromToken(req, token);
    const claims = this.facade.signer.verify(token as string, project, 'download', bucketName, key);
    const physical = await this.facade.physicalBucket(project, bucketName);
    const source = await this.facade.openIn(physical, key);
    // The transform was fixed when the URL was minted; the query cannot widen it.
    this.facade.pipeImage(res, source, key, transformOptionsFromQuery((claims.t as Record<string, unknown>) ?? {}), ifNoneMatch);
  }

  /** `uploadToSignedUrl`: the token carries project, object, owner and whether overwriting is allowed. */
  @Put('object/upload/sign/:bucket/:path(*)')
  @UseGuards(new ContentLengthGuard(maxUploadBytes))
  @UseInterceptors(new StorageMultipartInterceptor(maxUploadBytes))
  async signedUpload(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Query('token') token: string | undefined,
    @UploadedFiles() files: SpooledUpload[] | undefined,
  ) {
    const { input, cleanup } = uploadInputFrom(req, files);
    const release = uploadSlots.tryAcquire();
    if (!release) {
      await cleanup();
      throw new StorageFacadeError(
        { statusCode: '503', error: 'ServiceUnavailable', message: 'Too many uploads in progress, retry shortly' },
        503,
      );
    }
    try {
      const key = wildcardKey(req);
      const bucketName = normaliseBucketName(bucket);
      const project = await this.projectFromToken(req, token);
      const claims = this.facade.signer.verify(token as string, project, 'upload', bucketName, key);
      const who = claims.owner
        ? { caller: { kind: 'authenticated' as const, sub: claims.owner }, role: 'authenticated' as const, jwtClaims: { sub: claims.owner } }
        : this.facade.anonymous();
      // Authorisation happened when the URL was minted; the store is written as that caller.
      const { Key } = await this.facade.upload(project, who, bucketName, key, input, {
        upsert: claims.upsert,
        owner: claims.owner,
      });
      return { Key };
    } finally {
      release();
      await cleanup();
    }
  }

  // ── Project resolution ──────────────────────────────────

  private async projectFromRef(req: Request): Promise<FacadeProject> {
    const ref = req.headers['x-bf-project'];
    if (typeof ref !== 'string' || !ref) {
      throw StorageFacadeError.invalid(
        'Project reference missing: public storage URLs are served under /api/p/<projectId>/storage/v1/…',
      );
    }
    return this.awake(await this.facade.loadProject(ref));
  }

  private async projectFromToken(req: Request, token: string | undefined): Promise<FacadeProject> {
    if (!token) throw StorageFacadeError.invalidJwt('Missing token');
    const pid = this.facade.signer.peekProjectId(token);
    const ref = req.headers['x-bf-project'];
    if (typeof ref === 'string' && ref && ref !== pid) {
      throw StorageFacadeError.invalidJwt('The token was not issued for this project');
    }
    return this.awake(await this.facade.loadProject(pid));
  }

  private async awake(project: FacadeProject): Promise<FacadeProject> {
    if (project.status === 'PAUSED') {
      await this.wake.wake(project);
      return { ...project, status: 'ACTIVE' };
    }
    return project;
  }
}
