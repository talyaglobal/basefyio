import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as Minio from 'minio';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { QuotaService } from '../billing/quota.service';

export interface StorageObject {
  name: string;
  prefix?: string;
  size: number;
  lastModified: Date;
  etag?: string;
}

export interface BucketSummary {
  id: string;
  name: string;
  public: boolean;
  createdAt: string;
  objectCount: number;
  totalSize: number;
}

/** Platform-wide bucket for user feedback screenshots / clips (not project-scoped). */
const FEEDBACK_ATTACHMENTS_BUCKET = 'bf-platform-feedback';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: Minio.Client;
  private publicClient: Minio.Client;
  private publicEndpoint: string;
  private publicPort: number;
  private publicSsl: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quota: QuotaService,
  ) {
    const accessKey = this.config.get<string>('minio.accessKey') || 'kolaybase';
    const secretKey = this.config.get<string>('minio.secretKey') || 'kolaybase_secret';

    this.client = new Minio.Client({
      endPoint: this.config.get<string>('minio.endpoint') || 'localhost',
      port: this.config.get<number>('minio.port') || 9000,
      useSSL: this.config.get<boolean>('minio.useSsl') || false,
      accessKey,
      secretKey,
    });

    this.publicEndpoint = this.config.get<string>('minio.publicEndpoint') || 'localhost';
    this.publicPort = this.config.get<number>('minio.publicPort') || 9000;
    this.publicSsl = this.config.get<string>('minio.publicSsl') === 'true';

    this.publicClient = new Minio.Client({
      endPoint: this.publicEndpoint,
      port: this.publicPort,
      useSSL: this.publicSsl,
      accessKey,
      secretKey,
    });
  }

  private minioBucketName(projectSlug: string, bucketName: string): string {
    return `bf-${projectSlug}-${bucketName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  /**
   * Prefix for every MinIO bucket that belongs to a project — must match the start
   * of {@link minioBucketName} for that slug (any logical bucket name).
   */
  private minioProjectPrefix(projectSlug: string): string {
    return `bf-${projectSlug}-`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  /**
   * Shared MinIO: bucket `bf-warebnb-2-docs` starts with `bf-warebnb-` so it was
   * wrongly listed under slug `warebnb` as "2-docs" unless a sibling `warebnb-2`
   * row existed. Resolve owner by longest matching project prefix among all active projects.
   */
  private resolveMinioBucketOwner(
    minioBucketName: string,
    projects: { id: string; slug: string; storagePrefix?: string | null }[],
  ): { id: string; slug: string; storagePrefix?: string | null } | null {
    let best: { id: string; slug: string; storagePrefix?: string | null; prefixLen: number } | null = null;
    for (const p of projects) {
      const pref = this.minioProjectPrefix(p.storagePrefix ?? p.slug);
      if (minioBucketName.startsWith(pref)) {
        if (!best || pref.length > best.prefixLen) {
          best = { id: p.id, slug: p.slug, prefixLen: pref.length };
        }
      }
    }
    return best ? { id: best.id, slug: best.slug } : null;
  }

  private async assertProjectAccess(projectId: string, userId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (userId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!membership) throw new ForbiddenException('Not a member of this team');
    }

    return project;
  }

  // ── Bucket operations ──────────────────────────────────

  async listBuckets(projectId: string, userId?: string): Promise<BucketSummary[]> {
    const project = await this.assertProjectAccess(projectId, userId);
    const prefix = this.minioProjectPrefix(project.storagePrefix ?? project.slug);

    const allProjects = await this.prisma.project.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, storagePrefix: true },
    });

    const allBuckets = await this.client.listBuckets();
    const projectBuckets = allBuckets.filter((b) => {
      const owner = this.resolveMinioBucketOwner(b.name, allProjects);
      return owner?.id === project.id;
    });

    const results: BucketSummary[] = [];

    for (const b of projectBuckets) {
      const displayName = b.name.substring(prefix.length);
      const stats = await this.bucketStats(b.name);
      const isPublic = await this.isBucketPublic(b.name);

      results.push({
        id: b.name,
        name: displayName,
        public: isPublic,
        createdAt: b.creationDate.toISOString(),
        objectCount: stats.objectCount,
        totalSize: stats.totalSize,
      });
    }

    return results;
  }

  async createBucket(projectId: string, userId: string | undefined, name: string, isPublic = false) {
    const project = await this.assertProjectAccess(projectId, userId);

    if (!name || !/^[A-Za-z0-9][A-Za-z0-9-]{1,60}[A-Za-z0-9]$/.test(name)) {
      throw new BadRequestException(
        'Bucket name must be 3-63 chars, alphanumeric and hyphens, cannot start/end with hyphen',
      );
    }

    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, name);

    const exists = await this.client.bucketExists(minioBucket);
    if (exists) throw new ConflictException(`Bucket "${name}" already exists`);

    await this.client.makeBucket(minioBucket);

    if (isPublic) {
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${minioBucket}/*`],
          },
        ],
      });
      await this.client.setBucketPolicy(minioBucket, policy);
    }

    this.logger.log(`Bucket "${minioBucket}" created (public=${isPublic})`);

    return {
      id: minioBucket,
      name,
      public: isPublic,
      createdAt: new Date().toISOString(),
      objectCount: 0,
      totalSize: 0,
    };
  }

  async deleteBucket(projectId: string, userId: string | undefined, bucketName: string) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);

    const exists = await this.client.bucketExists(minioBucket);
    if (!exists) throw new NotFoundException(`Bucket "${bucketName}" not found`);

    // Remove all objects first
    const objects = await this.listAllObjects(minioBucket);
    if (objects.length > 0) {
      await this.client.removeObjects(minioBucket, objects.map((o) => o.name));
    }

    await this.client.removeBucket(minioBucket);
    this.logger.log(`Bucket "${minioBucket}" deleted`);
    return { message: `Bucket "${bucketName}" deleted` };
  }

  /**
   * Delete MinIO buckets for this project that are not in the remote source list.
   * Fixes ghost buckets like `2-docs` when physical name is `bf-{slug}-2-docs` (same
   * project prefix as `docs`) — listing logic cannot tell them apart without this cleanup.
   */
  async pruneProjectStorageBuckets(
    projectId: string,
    keepLogicalNames: Set<string>,
  ): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) return;

    const keep = new Set([...keepLogicalNames].map((s) => s.trim().toLowerCase()).filter(Boolean));
    if (keep.size === 0) return;

    const allProjects = await this.prisma.project.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, storagePrefix: true },
    });

    const prefix = this.minioProjectPrefix(project.storagePrefix ?? project.slug);
    const allBuckets = await this.client.listBuckets();

    for (const b of allBuckets) {
      const owner = this.resolveMinioBucketOwner(b.name, allProjects);
      if (owner?.id !== project.id) continue;

      const logical = b.name.substring(prefix.length).trim().toLowerCase();
      if (!logical || keep.has(logical)) continue;

      try {
        await this.deleteBucket(projectId, undefined, logical);
        this.logger.log(
          `Pruned storage bucket "${logical}" (not in remote source list) for project ${projectId}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to prune storage bucket "${logical}" for project ${projectId}: ${err.message}`,
        );
      }
    }
  }

  async toggleBucketPublic(projectId: string, userId: string | undefined, bucketName: string, isPublic: boolean) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);

    const exists = await this.client.bucketExists(minioBucket);
    if (!exists) throw new NotFoundException(`Bucket "${bucketName}" not found`);

    if (isPublic) {
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${minioBucket}/*`],
          },
        ],
      });
      await this.client.setBucketPolicy(minioBucket, policy);
    } else {
      await this.client.setBucketPolicy(minioBucket, '');
    }

    return { public: isPublic };
  }

  // ── Object operations ──────────────────────────────────

  async listObjects(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    prefix = '',
    recursive = false,
  ): Promise<StorageObject[]> {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);

    const exists = await this.client.bucketExists(minioBucket);
    if (!exists) throw new NotFoundException(`Bucket "${bucketName}" not found`);

    return new Promise((resolve, reject) => {
      const objects: StorageObject[] = [];
      const stream = this.client.listObjectsV2(minioBucket, prefix, recursive);
      stream.on('data', (obj) => {
        objects.push({
          name: obj.name || '',
          prefix: obj.prefix,
          size: obj.size || 0,
          lastModified: obj.lastModified || new Date(),
          etag: obj.etag,
        });
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(objects));
    });
  }

  /** Create an empty "folder" — a zero-byte marker object whose key ends in '/'. */
  async createFolder(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    folderPath: string,
  ) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);
    const exists = await this.client.bucketExists(minioBucket);
    if (!exists) throw new NotFoundException(`Bucket "${bucketName}" not found`);

    const clean = (folderPath || '').replace(/^\/+|\/+$/g, '').trim();
    if (!clean) throw new BadRequestException('Folder name is required');
    if (clean.includes('..') || clean.split('/').some((seg) => seg.trim() === '')) {
      throw new BadRequestException('Invalid folder path');
    }

    const marker = `${clean}/`;
    await this.client.putObject(minioBucket, marker, Buffer.alloc(0), 0, {
      'Content-Type': 'application/x-directory',
    });
    this.logger.log(`Folder "${marker}" created in "${minioBucket}"`);
    return { name: marker };
  }

  /** Build the anonymous public URL for an object/prefix in a (public) bucket. */
  private buildPublicUrl(minioBucket: string, path = ''): string {
    const scheme = this.publicSsl ? 'https' : 'http';
    const omitPort =
      (this.publicSsl && this.publicPort === 443) || (!this.publicSsl && this.publicPort === 80);
    const host = omitPort ? this.publicEndpoint : `${this.publicEndpoint}:${this.publicPort}`;
    const clean = (path || '').replace(/^\/+/, '');
    return `${scheme}://${host}/${minioBucket}/${clean}`;
  }

  /**
   * Public URL for a bucket root, a folder prefix, or an object. Only returns a
   * URL when the bucket is public (anonymous s3:GetObject) — otherwise the URL
   * would 403. For a folder/bucket this is the base that, with an object name
   * appended, yields a working public link (object storage has no anonymous
   * directory listing).
   */
  async getPublicUrl(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    path = '',
  ): Promise<{ public: boolean; url: string | null }> {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);
    const exists = await this.client.bucketExists(minioBucket);
    if (!exists) throw new NotFoundException(`Bucket "${bucketName}" not found`);
    const isPublic = await this.isBucketPublic(minioBucket);
    if (!isPublic) return { public: false, url: null };
    return { public: true, url: this.buildPublicUrl(minioBucket, path) };
  }

  /** Which of the given object paths already exist in the bucket (for overwrite prompts). */
  async findExistingObjects(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    paths: string[],
  ): Promise<string[]> {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);
    const exists = await this.client.bucketExists(minioBucket);
    if (!exists) throw new NotFoundException(`Bucket "${bucketName}" not found`);
    const found: string[] = [];
    await Promise.all(
      (paths || []).slice(0, 1000).map(async (p) => {
        const key = (p || '').replace(/^\/+/, '');
        if (!key) return;
        try {
          await this.client.statObject(minioBucket, key);
          found.push(key);
        } catch {
          /* not found */
        }
      }),
    );
    return found;
  }

  async uploadObject(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    path: string,
    buffer: Buffer,
    contentType: string,
  ) {
    if (!path || path === '/') {
      throw new BadRequestException('File path is required');
    }

    const project = await this.assertProjectAccess(projectId, userId);
    await this.quota.assertCanUploadStorage(project.teamId, buffer.length);

    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);

    const exists = await this.client.bucketExists(minioBucket);
    if (!exists) throw new NotFoundException(`Bucket "${bucketName}" not found`);

    const objectName = path.replace(/^\/+/, '');

    await this.client.putObject(minioBucket, objectName, buffer, buffer.length, {
      'Content-Type': contentType,
    });

    this.logger.log(`Uploaded "${objectName}" to "${minioBucket}"`);

    const stat = await this.client.statObject(minioBucket, objectName);
    return {
      name: objectName,
      size: stat.size,
      contentType: stat.metaData?.['content-type'] || contentType,
      lastModified: stat.lastModified,
      etag: stat.etag,
    };
  }

  async getObject(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    objectName: string,
  ): Promise<{ stream: Readable; stat: Minio.BucketItemStat }> {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);

    try {
      const stat = await this.client.statObject(minioBucket, objectName);
      const stream = await this.client.getObject(minioBucket, objectName);
      return { stream, stat };
    } catch (err: any) {
      if (err.code === 'NotFound' || err.code === 'NoSuchKey') {
        throw new NotFoundException(`Object "${objectName}" not found`);
      }
      throw new InternalServerErrorException(`Failed to get object: ${err.message}`);
    }
  }

  async deleteObjects(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    objectNames: string[],
  ) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);

    await this.client.removeObjects(minioBucket, objectNames);
    this.logger.log(`Deleted ${objectNames.length} object(s) from "${minioBucket}"`);
    return { message: `Deleted ${objectNames.length} object(s)` };
  }

  async getPresignedUrl(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    objectName: string,
    expiry = 3600,
  ) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.storagePrefix ?? project.slug, bucketName);

    // Important: generate the signed URL using the public endpoint client directly.
    // Rewriting host/port after signing can invalidate the signature in production.
    const url = await this.publicClient.presignedGetObject(minioBucket, objectName, expiry);

    return { url, expiresIn: expiry };
  }

  // ── Helpers ────────────────────────────────────────────

  private async bucketStats(minioBucket: string) {
    let totalSize = 0;
    let objectCount = 0;

    return new Promise<{ totalSize: number; objectCount: number }>((resolve, reject) => {
      const stream = this.client.listObjectsV2(minioBucket, '', true);
      stream.on('data', (obj) => {
        const name = obj.name || '';
        const size = obj.size || 0;
        // Ignore pseudo-folder marker objects (e.g. "folder/") so UI count matches real files.
        const isFolderMarker = name.endsWith('/') && size === 0;
        if (isFolderMarker) return;
        totalSize += size;
        objectCount++;
      });
      stream.on('error', reject);
      stream.on('end', () => resolve({ totalSize, objectCount }));
    });
  }

  private async isBucketPublic(minioBucket: string): Promise<boolean> {
    try {
      const policy = await this.client.getBucketPolicy(minioBucket);
      if (!policy) return false;
      const parsed = JSON.parse(policy);
      return (parsed.Statement || []).some(
        (s: any) =>
          s.Effect === 'Allow' &&
          JSON.stringify(s.Principal) === JSON.stringify({ AWS: ['*'] }) &&
          (s.Action || []).includes('s3:GetObject'),
      );
    } catch {
      return false;
    }
  }

  private async listAllObjects(minioBucket: string): Promise<StorageObject[]> {
    return new Promise((resolve, reject) => {
      const objects: StorageObject[] = [];
      const stream = this.client.listObjectsV2(minioBucket, '', true);
      stream.on('data', (obj) => {
        objects.push({
          name: obj.name || '',
          size: obj.size || 0,
          lastModified: obj.lastModified || new Date(),
        });
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(objects));
    });
  }

  /**
   * Upload a single image or video for the feedback form. Bucket is public-read for direct links in admin UI / email.
   */
  async uploadFeedbackAttachment(
    userId: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<{ url: string; mimeType: string; kind: 'image' | 'video' }> {
    const isImage = contentType.startsWith('image/');
    const isVideo = contentType.startsWith('video/');
    if (!isImage && !isVideo) {
      throw new BadRequestException('Only image or video files are allowed');
    }
    const maxImage = 5 * 1024 * 1024;
    const maxVideo = 20 * 1024 * 1024;
    if (isImage && buffer.length > maxImage) {
      throw new BadRequestException('Image too large (max 5 MB)');
    }
    if (isVideo && buffer.length > maxVideo) {
      throw new BadRequestException('Video too large (max 20 MB)');
    }

    const bucket = FEEDBACK_ATTACHMENTS_BUCKET;
    const exists = await this.client.bucketExists(bucket);
    if (!exists) {
      await this.client.makeBucket(bucket, '');
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucket}/*`],
          },
        ],
      });
      await this.client.setBucketPolicy(bucket, policy);
    }

    let ext = 'bin';
    if (isImage) {
      if (contentType.includes('png')) ext = 'png';
      else if (contentType.includes('webp')) ext = 'webp';
      else if (contentType.includes('gif')) ext = 'gif';
      else if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
    } else {
      if (contentType.includes('webm')) ext = 'webm';
      else if (contentType.includes('quicktime') || contentType.includes('mov')) ext = 'mov';
      else ext = 'mp4';
    }

    const objectName = `${userId}/${Date.now()}-${randomBytes(8).toString('hex')}.${ext}`;

    await this.client.putObject(bucket, objectName, buffer, buffer.length, {
      'Content-Type': contentType,
    });

    const publicHost = this.publicSsl
      ? `https://${this.publicEndpoint}:${this.publicPort}`
      : `http://${this.publicEndpoint}:${this.publicPort}`;

    const url = `${publicHost}/${bucket}/${objectName}`;
    return {
      url,
      mimeType: contentType,
      kind: isVideo ? 'video' : 'image',
    };
  }

  async ensurePlatformBucket(bucketName: string): Promise<void> {
    const exists = await this.client.bucketExists(bucketName);
    if (!exists) {
      await this.client.makeBucket(bucketName);
    }
  }

  async uploadPlatformFileFromPath(
    bucketName: string,
    objectName: string,
    filePath: string,
    contentType = 'application/octet-stream',
  ): Promise<{ size: number; etag?: string }> {
    await this.ensurePlatformBucket(bucketName);
    const fileStat = await stat(filePath);
    const stream = createReadStream(filePath);
    const uploaded = await this.client.putObject(
      bucketName,
      objectName,
      stream,
      fileStat.size,
      { 'Content-Type': contentType },
    );
    const etag = typeof uploaded === 'string' ? uploaded : uploaded?.etag;
    return { size: fileStat.size, etag };
  }

  async getPlatformObject(
    bucketName: string,
    objectName: string,
  ): Promise<{ stream: Readable; stat: Minio.BucketItemStat }> {
    const stat = await this.client.statObject(bucketName, objectName);
    const stream = await this.client.getObject(bucketName, objectName);
    return { stream, stat };
  }

  async removePlatformObject(bucketName: string, objectName: string): Promise<void> {
    await this.client.removeObject(bucketName, objectName);
  }

  async listPlatformObjects(
    bucketName: string,
    prefix = '',
  ): Promise<StorageObject[]> {
    return new Promise((resolve, reject) => {
      const objects: StorageObject[] = [];
      const stream = this.client.listObjectsV2(bucketName, prefix, true);
      stream.on('data', (obj) => {
        objects.push({
          name: obj.name || '',
          size: obj.size || 0,
          lastModified: obj.lastModified || new Date(),
          etag: obj.etag,
        });
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(objects));
    });
  }
}
