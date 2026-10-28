import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma, StorageUploadSession } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { QuotaService } from '../billing/quota.service';
import { RedisService } from '../redis/redis.service';
import { StorageService } from './storage.service';
import { StorageAccessService } from './storage-access.service';
import { StorageCaller, isPrivileged, ownerMeta, ownerTag } from './storage-caller';
import { StorageCatalogService } from './storage-catalog.service';

/** S3 and compatible stores require every part but the last to be at least this large. */
export const MIN_CHUNK_BYTES = 5 * 1024 * 1024;
/** Upper bound on one chunk; also the most memory one PATCH can hold. */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** Media type a chunk must be sent as — anything else is refused before the body is read. */
export const CHUNK_CONTENT_TYPE = 'application/offset+octet-stream';

const LOCK_TTL_SECONDS = 60;
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EXPIRE_BATCH = 200;

export interface UploadPart {
  part: number;
  etag: string;
  size: number;
}

export interface CreateUploadSessionInput {
  path: string;
  size: number;
  contentType?: string;
  chunkSize?: number;
}

/** What clients see of a session. */
export interface UploadSessionView {
  id: string;
  bucket: string;
  path: string;
  offset: number;
  size: number;
  chunkSize: number;
  contentType: string;
  status: string;
  expiresAt: string;
}

export interface CompletedUpload {
  name: string;
  size: number;
  contentType: string;
  lastModified: Date;
  etag?: string;
  sessionId: string;
}

/** 409 that also tells the client where the server actually is. */
export class UploadOffsetMismatchException extends ConflictException {
  constructor(readonly offset: number) {
    super({ statusCode: 409, message: 'Upload offset mismatch; resume from the offset in Upload-Offset', offset });
  }
}

function positive(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Reads a raw request body into memory, stopping at `maxBytes`. Only used for
 * chunk uploads, whose size is bounded by the session's chunk size.
 */
export function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if ((req as any).readableEnded) {
      reject(new BadRequestException('Request body was already consumed'));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        settle(() => {
          reject(new PayloadTooLargeException(`Chunk exceeds ${maxBytes} bytes`));
          req.destroy();
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    req.on('error', (err) => settle(() => reject(err)));
    req.on('aborted', () => settle(() => reject(new BadRequestException('Upload aborted by the client'))));
  });
}

/**
 * Resumable uploads: a session is one native multipart upload on the store.
 * Chunks arrive as PATCH bodies with an Upload-Offset, each becomes a part,
 * and `complete` assembles them server-side — nothing is ever spooled here.
 * The session row is the source of truth for the parts the store has
 * acknowledged; a Redis lock serialises concurrent PATCHes on one session.
 */
@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);
  readonly defaultChunkBytes: number;
  readonly maxTotalBytes: number;
  readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly quota: QuotaService,
    private readonly storage: StorageService,
    private readonly access: StorageAccessService,
    @Optional() private readonly catalog?: StorageCatalogService,
  ) {
    const chunkMb = positive(this.config.get('storage.resumable.chunkMb'), 8);
    this.defaultChunkBytes = Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(chunkMb * 1024 * 1024)));
    this.maxTotalBytes = Math.floor(positive(this.config.get('storage.resumable.maxMb'), 5120) * 1024 * 1024);
    this.ttlMs = Math.floor(positive(this.config.get('storage.resumable.ttlHours'), 24) * 60 * 60 * 1000);
  }

  // ── Lifecycle ───────────────────────────────────────────

  async createUploadSession(
    projectId: string,
    caller: StorageCaller,
    dashboardUserId: string | undefined,
    bucket: string,
    input: CreateUploadSessionInput,
  ): Promise<UploadSessionView> {
    const path = String(input?.path ?? '').replace(/^\/+/, '');
    if (!path || path.endsWith('/')) throw new BadRequestException('path must name a file');
    if (path.includes('..') || path.includes('\0')) throw new BadRequestException('Invalid path');

    const size = Number(input?.size);
    if (!Number.isInteger(size) || size <= 0) {
      throw new BadRequestException('size must be a positive integer (use the regular upload for empty files)');
    }
    if (size > this.maxTotalBytes) {
      const mb = Math.floor(this.maxTotalBytes / (1024 * 1024));
      throw new PayloadTooLargeException(`size exceeds the resumable upload limit of ${mb} MB`);
    }

    const chunkSize = this.chunkSizeFor(size, input?.chunkSize);
    const contentType = (input?.contentType || 'application/octet-stream').slice(0, 255);

    const { project, minioBucket } = await this.storage.resolveBucket(projectId, dashboardUserId, bucket);
    await this.quota.assertCanUploadStorage(project.teamId, size);

    const mode = await this.access.resolveMode(projectId, bucket, path);
    if (mode === 'owner-only' && !isPrivileged(caller)) {
      const existing = await this.storage.statObjectIn(minioBucket, path);
      this.access.assertCanOverwrite(caller, mode, existing, path);
    }

    const uploadId = await this.storage.beginMultipart(minioBucket, path, {
      'Content-Type': contentType,
      ...ownerMeta(caller),
    });

    const row = await this.prisma.storageUploadSession.create({
      data: {
        projectId,
        bucket,
        objectKey: path,
        contentType,
        totalSize: BigInt(size),
        chunkSize,
        uploadId,
        parts: [],
        ownerSub: ownerTag(caller) ?? null,
        callerKind: caller.kind,
        expiresAt: new Date(Date.now() + this.ttlMs),
      },
    });
    this.logger.log(`Upload session ${row.id} opened for "${path}" in "${minioBucket}" (${size} bytes, chunk ${chunkSize})`);
    return this.view(row);
  }

  async getSession(
    projectId: string,
    caller: StorageCaller,
    dashboardUserId: string | undefined,
    bucket: string,
    sessionId: string,
  ): Promise<UploadSessionView> {
    await this.storage.resolveProject(projectId, dashboardUserId);
    const row = await this.loadOwned(projectId, bucket, sessionId, caller);
    return this.view(row);
  }

  async appendChunk(
    projectId: string,
    caller: StorageCaller,
    dashboardUserId: string | undefined,
    bucket: string,
    sessionId: string,
    offset: number,
    body: Buffer,
  ): Promise<UploadSessionView> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('Upload-Offset must be a non-negative integer');
    }
    const { project } = await this.storage.resolveProject(projectId, dashboardUserId).then((p) => ({ project: p }));

    const lockKey = `storage:upsess:${sessionId}`;
    let locked = false;
    try {
      const ok = await this.redis.getClient().set(lockKey, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
      locked = ok === 'OK';
    } catch (err: any) {
      throw new ServiceUnavailableException(`Upload coordination unavailable: ${err?.message ?? err}`);
    }
    if (!locked) throw new ConflictException('Another chunk of this upload is in flight; retry shortly');

    try {
      const row = await this.loadOwned(projectId, bucket, sessionId, caller);
      this.assertActive(row);

      const uploaded = Number(row.uploadedSize);
      const total = Number(row.totalSize);
      if (offset !== uploaded) throw new UploadOffsetMismatchException(uploaded);

      const len = body.length;
      if (len === 0) throw new BadRequestException('Empty chunk');
      if (len > row.chunkSize) throw new PayloadTooLargeException(`Chunk exceeds the session chunk size of ${row.chunkSize} bytes`);
      if (offset + len > total) throw new BadRequestException('Chunk runs past the declared size');
      const isLast = offset + len === total;
      if (!isLast && len !== row.chunkSize) {
        throw new BadRequestException(`Every chunk except the last must be exactly ${row.chunkSize} bytes`);
      }

      const partNumber = Math.floor(offset / row.chunkSize) + 1;
      const minioBucket = this.storage.physicalBucketName(project, bucket);
      const etag = await this.storage.putPart(minioBucket, row.objectKey, row.uploadId, partNumber, body);

      const parts = [...this.parts(row), { part: partNumber, etag, size: len }];
      const updated = await this.prisma.storageUploadSession.updateMany({
        where: { id: row.id, uploadedSize: row.uploadedSize, status: 'active' },
        data: { uploadedSize: BigInt(offset + len), parts: parts as unknown as Prisma.InputJsonValue },
      });
      if (updated.count !== 1) throw new UploadOffsetMismatchException(uploaded);

      return this.view({ ...row, uploadedSize: BigInt(offset + len), parts: parts as unknown as Prisma.JsonValue });
    } finally {
      try {
        await this.redis.getClient().del(lockKey);
      } catch {
        /* the lock expires on its own */
      }
    }
  }

  async complete(
    projectId: string,
    caller: StorageCaller,
    dashboardUserId: string | undefined,
    bucket: string,
    sessionId: string,
  ): Promise<CompletedUpload> {
    const project = await this.storage.resolveProject(projectId, dashboardUserId);
    const row = await this.loadOwned(projectId, bucket, sessionId, caller);
    this.assertActive(row);

    const uploaded = Number(row.uploadedSize);
    const total = Number(row.totalSize);
    if (uploaded !== total) {
      throw new BadRequestException(`Upload incomplete: ${uploaded} of ${total} bytes received`);
    }

    const minioBucket = this.storage.physicalBucketName(project, bucket);
    const parts = this.parts(row)
      .slice()
      .sort((a, b) => a.part - b.part)
      .map((p) => ({ part: p.part, etag: p.etag }));
    await this.storage.finishMultipart(minioBucket, row.objectKey, row.uploadId, parts);

    const stat = await this.storage.statObjectIn(minioBucket, row.objectKey);
    if (!stat) throw new InternalServerErrorException('The assembled object could not be read back');
    if (stat.size !== total) {
      throw new InternalServerErrorException(`Assembled object is ${stat.size} bytes, expected ${total}`);
    }

    await this.prisma.storageUploadSession.update({ where: { id: row.id }, data: { status: 'completed' } });
    this.logger.log(`Upload session ${row.id} completed: "${row.objectKey}" (${stat.size} bytes)`);
    // The assembled object reaches the catalog like a single-request upload does.
    await this.catalog?.recordUpload(
      projectId,
      bucket,
      row.objectKey,
      stat,
      stat.metaData?.['content-type'] || row.contentType,
      row.ownerSub ? { 'x-amz-meta-owner': row.ownerSub } : undefined,
    );
    return {
      name: row.objectKey,
      size: stat.size,
      contentType: stat.metaData?.['content-type'] || row.contentType,
      lastModified: stat.lastModified,
      etag: stat.etag,
      sessionId: row.id,
    };
  }

  async abort(
    projectId: string,
    caller: StorageCaller,
    dashboardUserId: string | undefined,
    bucket: string,
    sessionId: string,
  ): Promise<void> {
    const project = await this.storage.resolveProject(projectId, dashboardUserId);
    const row = await this.loadOwned(projectId, bucket, sessionId, caller);
    if (row.status !== 'active') return;
    const minioBucket = this.storage.physicalBucketName(project, bucket);
    await this.storage.abortMultipart(minioBucket, row.objectKey, row.uploadId);
    await this.prisma.storageUploadSession.update({ where: { id: row.id }, data: { status: 'aborted' } });
  }

  // ── Housekeeping ────────────────────────────────────────

  /**
   * Hourly: abort the multipart upload behind every session past its TTL and
   * forget finished sessions after a week. Idempotent, so running on more than
   * one instance is harmless.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireStaleSessions(now: Date = new Date()): Promise<{ expired: number; purged: number }> {
    let expired = 0;
    let purged = 0;
    try {
      const stale = await this.prisma.storageUploadSession.findMany({
        where: { status: 'active', expiresAt: { lt: now } },
        take: EXPIRE_BATCH,
      });
      for (const row of stale) {
        try {
          const project = await this.prisma.project.findUnique({
            where: { id: row.projectId },
            select: { slug: true, storagePrefix: true },
          });
          if (project) {
            const minioBucket = this.storage.physicalBucketName(project, row.bucket);
            await this.storage.abortMultipart(minioBucket, row.objectKey, row.uploadId);
          }
        } catch (err: any) {
          this.logger.warn(`Could not abort multipart upload for session ${row.id}: ${err?.message ?? err}`);
        }
        const res = await this.prisma.storageUploadSession.updateMany({
          where: { id: row.id, status: 'active' },
          data: { status: 'expired' },
        });
        expired += res.count;
      }
      const old = await this.prisma.storageUploadSession.deleteMany({
        where: { status: { not: 'active' }, updatedAt: { lt: new Date(now.getTime() - FINISHED_RETENTION_MS) } },
      });
      purged = old.count;
      if (expired || purged) this.logger.log(`Upload sessions: ${expired} expired, ${purged} purged`);
    } catch (err: any) {
      this.logger.warn(`Upload session sweep failed: ${err?.message ?? err}`);
    }
    return { expired, purged };
  }

  // ── Helpers ─────────────────────────────────────────────

  /** Default or requested chunk, clamped to what the store accepts; a small file is one chunk. */
  chunkSizeFor(size: number, requested?: number): number {
    if (size <= MIN_CHUNK_BYTES) return size;
    const want = Number.isFinite(Number(requested)) && Number(requested) > 0 ? Math.floor(Number(requested)) : this.defaultChunkBytes;
    const clamped = Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, want));
    return Math.min(clamped, size);
  }

  private parts(row: StorageUploadSession): UploadPart[] {
    const raw = row.parts;
    return Array.isArray(raw) ? (raw as unknown as UploadPart[]) : [];
  }

  private view(row: StorageUploadSession): UploadSessionView {
    return {
      id: row.id,
      bucket: row.bucket,
      path: row.objectKey,
      offset: Number(row.uploadedSize),
      size: Number(row.totalSize),
      chunkSize: row.chunkSize,
      contentType: row.contentType,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  private assertActive(row: StorageUploadSession): void {
    if (row.status !== 'active') {
      throw new GoneException(`Upload session is ${row.status}`);
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new GoneException('Upload session has expired');
    }
  }

  /** The session, provided it belongs to this project and bucket and the caller may touch it. */
  private async loadOwned(
    projectId: string,
    bucket: string,
    sessionId: string,
    caller: StorageCaller,
  ): Promise<StorageUploadSession> {
    const row = await this.prisma.storageUploadSession.findUnique({ where: { id: sessionId } });
    if (!row || row.projectId !== projectId || row.bucket !== bucket) {
      throw new NotFoundException('Upload session not found');
    }
    if (isPrivileged(caller)) return row;
    if (caller.kind === 'authenticated' && row.ownerSub && row.ownerSub === caller.sub) return row;
    throw new ForbiddenException('This upload session belongs to another user');
  }
}
