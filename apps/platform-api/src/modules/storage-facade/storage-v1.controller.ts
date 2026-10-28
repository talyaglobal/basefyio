import {
  Body,
  Controller,
  Delete,
  Get,
  Head,
  Headers,
  Param,
  Post,
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
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { AnonKeyAllowed, ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import { ContentLengthGuard, Semaphore, resolveMaxConcurrentUploads, resolveMaxUploadBytes } from '../storage/upload-spool';
import { MAX_FILE_SIZE } from '../storage/storage.controller';
import { StorageFacadeService } from './storage-facade.service';
import { StorageFacadeError, SupabaseStorageExceptionFilter } from './storage-facade.errors';
import { normaliseBucketName, normaliseKey, transformOptionsFromQuery, wildcardKey } from './storage-facade.util';
import { uploadInputFrom } from './storage-upload';
import { SpooledUpload, StorageMultipartInterceptor } from './storage-multipart.interceptor';

const maxUploadBytes = resolveMaxUploadBytes(MAX_FILE_SIZE);
const uploadSlots = new Semaphore(resolveMaxConcurrentUploads());

/**
 * Supabase Storage API, keyed routes: what `supabase.storage.from(bucket)`
 * and the bucket methods call. Every route needs the project's anon or
 * service key (the guard); what a given key may do with a given object is
 * decided per project by StorageFacadeService.
 *
 * Literal routes (`object/list/…`, `object/sign/…`, `object/info/…`,
 * `object/move`, `object/copy`) are declared before `object/:bucket/*` so
 * Express never reads a verb as a bucket name. The public and signed
 * routes live in StorageV1PublicController, which is registered first.
 */
@Controller('storage/v1')
@UseGuards(ApiKeyGuard)
@AnonKeyAllowed()
@SkipThrottle()
@UseFilters(SupabaseStorageExceptionFilter)
export class StorageV1Controller {
  constructor(private readonly facade: StorageFacadeService) {}

  // ── Buckets ─────────────────────────────────────────────

  @Get('bucket')
  async listBuckets(@Req() req: Request) {
    const project = await this.facade.projectOfKey(req);
    return this.facade.listBuckets(project, this.facade.callerOf(req));
  }

  @Post('bucket')
  @ServiceKeyOnly()
  async createBucket(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const project = await this.facade.projectOfKey(req);
    return this.facade.createBucket(project, body ?? {});
  }

  @Get('bucket/:id')
  async getBucket(@Req() req: Request, @Param('id') id: string) {
    const project = await this.facade.projectOfKey(req);
    return this.facade.getBucket(project, this.facade.callerOf(req), normaliseBucketName(id));
  }

  @Put('bucket/:id')
  @ServiceKeyOnly()
  async updateBucket(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const project = await this.facade.projectOfKey(req);
    return this.facade.updateBucket(project, normaliseBucketName(id), body ?? {});
  }

  @Post('bucket/:id/empty')
  @ServiceKeyOnly()
  async emptyBucket(@Req() req: Request, @Param('id') id: string) {
    const project = await this.facade.projectOfKey(req);
    return this.facade.emptyBucket(project, normaliseBucketName(id));
  }

  @Delete('bucket/:id')
  @ServiceKeyOnly()
  async deleteBucket(@Req() req: Request, @Param('id') id: string) {
    const project = await this.facade.projectOfKey(req);
    return this.facade.deleteBucket(project, normaliseBucketName(id));
  }

  // ── Object verbs (literal routes first) ─────────────────

  @Post('object/list/:bucket')
  async list(@Req() req: Request, @Param('bucket') bucket: string, @Body() body: Record<string, unknown>) {
    const project = await this.facade.projectOfKey(req);
    return this.facade.list(project, this.facade.callerOf(req), normaliseBucketName(bucket), body);
  }

  /** `createSignedUrls`: one token per path, failures reported per entry. */
  @Post('object/sign/:bucket')
  async signMany(@Req() req: Request, @Param('bucket') bucket: string, @Body() body: Record<string, unknown>) {
    const project = await this.facade.projectOfKey(req);
    const expiresIn = this.facade.signer.validateExpiry(body?.expiresIn);
    const paths = Array.isArray(body?.paths) ? body.paths.map(String) : [];
    return this.facade.signMany(project, this.facade.callerOf(req), normaliseBucketName(bucket), expiresIn, paths);
  }

  @Post('object/sign/:bucket/:path(*)')
  async sign(@Req() req: Request, @Param('bucket') bucket: string, @Body() body: Record<string, unknown>) {
    const project = await this.facade.projectOfKey(req);
    const expiresIn = this.facade.signer.validateExpiry(body?.expiresIn);
    const transform = body?.transform && typeof body.transform === 'object' ? (body.transform as Record<string, unknown>) : undefined;
    return this.facade.sign(project, this.facade.callerOf(req), normaliseBucketName(bucket), wildcardKey(req), expiresIn, transform);
  }

  @Post('object/upload/sign/:bucket/:path(*)')
  async signUpload(@Req() req: Request, @Param('bucket') bucket: string, @Headers('x-upsert') upsert: string | undefined) {
    const project = await this.facade.projectOfKey(req);
    const { url } = await this.facade.signUpload(
      project,
      this.facade.callerOf(req),
      normaliseBucketName(bucket),
      wildcardKey(req),
      String(upsert).toLowerCase() === 'true',
    );
    return { url };
  }

  @Post('object/move')
  async move(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const project = await this.facade.projectOfKey(req);
    const { bucket, source, destination, destinationBucket } = this.moveArgs(body);
    return this.facade.move(project, this.facade.callerOf(req), bucket, source, destination, destinationBucket);
  }

  @Post('object/copy')
  async copy(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const project = await this.facade.projectOfKey(req);
    const { bucket, source, destination, destinationBucket } = this.moveArgs(body);
    return this.facade.copy(project, this.facade.callerOf(req), bucket, source, destination, destinationBucket);
  }

  @Get('object/info/:bucket/:path(*)')
  async info(@Req() req: Request, @Param('bucket') bucket: string) {
    const project = await this.facade.projectOfKey(req);
    return this.facade.info(project, this.facade.callerOf(req), normaliseBucketName(bucket), wildcardKey(req));
  }

  @Get('object/authenticated/:bucket/:path(*)')
  async downloadAuthenticated(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    return this.download(req, bucket, download, res);
  }

  @Get('render/image/authenticated/:bucket/:path(*)')
  async render(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    const project = await this.facade.projectOfKey(req);
    const key = wildcardKey(req);
    const source = await this.facade.open(project, this.facade.callerOf(req), normaliseBucketName(bucket), key);
    this.facade.pipeImage(res, source, key, transformOptionsFromQuery(query ?? {}), ifNoneMatch);
  }

  // ── Object CRUD (wildcard routes last) ──────────────────

  @Post('object/:bucket/:path(*)')
  @UseGuards(new ContentLengthGuard(maxUploadBytes))
  @UseInterceptors(new StorageMultipartInterceptor(maxUploadBytes))
  async upload(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Headers('x-upsert') upsert: string | undefined,
    @UploadedFiles() files: SpooledUpload[] | undefined,
  ) {
    return this.store(req, bucket, files, String(upsert).toLowerCase() === 'true');
  }

  /** `update()`: always an upsert. */
  @Put('object/:bucket/:path(*)')
  @UseGuards(new ContentLengthGuard(maxUploadBytes))
  @UseInterceptors(new StorageMultipartInterceptor(maxUploadBytes))
  async update(@Req() req: Request, @Param('bucket') bucket: string, @UploadedFiles() files: SpooledUpload[] | undefined) {
    return this.store(req, bucket, files, true);
  }

  @Head('object/:bucket/:path(*)')
  async exists(@Req() req: Request, @Param('bucket') bucket: string, @Res() res: Response) {
    const project = await this.facade.projectOfKey(req);
    const key = wildcardKey(req);
    const { stat } = await this.facade.stat(project, this.facade.callerOf(req), normaliseBucketName(bucket), key);
    this.facade.writeHead(res, stat, key);
  }

  @Get('object/:bucket/:path(*)')
  async download(
    @Req() req: Request,
    @Param('bucket') bucket: string,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    const project = await this.facade.projectOfKey(req);
    const key = wildcardKey(req);
    const source = await this.facade.open(
      project,
      this.facade.callerOf(req),
      normaliseBucketName(bucket),
      key,
      req.headers.range as string | undefined,
    );
    this.facade.pipeBytes(res, source, key, download === undefined ? undefined : download || true);
  }

  @Delete('object/:bucket')
  async remove(@Req() req: Request, @Param('bucket') bucket: string, @Body() body: Record<string, unknown>) {
    const project = await this.facade.projectOfKey(req);
    const prefixes = Array.isArray(body?.prefixes) ? body.prefixes : [];
    const keys = prefixes.map((p: unknown) => normaliseKey(p));
    return this.facade.remove(project, this.facade.callerOf(req), normaliseBucketName(bucket), keys);
  }

  // ── Helpers ─────────────────────────────────────────────

  private async store(req: Request, bucket: string, files: SpooledUpload[] | undefined, upsert: boolean) {
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
      const project = await this.facade.projectOfKey(req);
      return await this.facade.upload(project, this.facade.callerOf(req), normaliseBucketName(bucket), wildcardKey(req), input, { upsert });
    } finally {
      release();
      await cleanup();
    }
  }

  private moveArgs(body: Record<string, unknown>) {
    const bucket = normaliseBucketName(body?.bucketId);
    const source = normaliseKey(body?.sourceKey);
    const destination = normaliseKey(body?.destinationKey);
    const destinationBucket =
      body?.destinationBucket === undefined || body.destinationBucket === null || body.destinationBucket === ''
        ? bucket
        : normaliseBucketName(body.destinationBucket);
    return { bucket, source, destination, destinationBucket };
  }
}
