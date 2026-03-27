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
import * as Minio from 'minio';
import { Readable } from 'stream';
import { PrismaService } from '../../prisma/prisma.service';

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
    return `kb-${projectSlug}-${bucketName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
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
    const prefix = `kb-${project.slug}-`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Other projects whose slugs extend this project's slug (e.g. "foo-2" when
    // this project's slug is "foo") would produce MinIO bucket names that also
    // start with this project's prefix.  Find those prefixes and exclude them.
    const siblingProjects = await this.prisma.project.findMany({
      where: { id: { not: projectId }, slug: { startsWith: project.slug } },
      select: { slug: true },
    });
    const excludedPrefixes = siblingProjects
      .map((p) =>
        `kb-${p.slug}-`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      )
      .filter((ep) => ep !== prefix && ep.startsWith(prefix));

    const allBuckets = await this.client.listBuckets();
    const projectBuckets = allBuckets.filter(
      (b) =>
        b.name.startsWith(prefix) &&
        !excludedPrefixes.some((ep) => b.name.startsWith(ep)),
    );

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

    if (!name || !/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(name)) {
      throw new BadRequestException(
        'Bucket name must be 3-63 chars, lowercase alphanumeric and hyphens, cannot start/end with hyphen',
      );
    }

    const minioBucket = this.minioBucketName(project.slug, name);

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
    const minioBucket = this.minioBucketName(project.slug, bucketName);

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

  async toggleBucketPublic(projectId: string, userId: string | undefined, bucketName: string, isPublic: boolean) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.slug, bucketName);

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
    const minioBucket = this.minioBucketName(project.slug, bucketName);

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
    const minioBucket = this.minioBucketName(project.slug, bucketName);

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
    const minioBucket = this.minioBucketName(project.slug, bucketName);

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
    const minioBucket = this.minioBucketName(project.slug, bucketName);

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
    const minioBucket = this.minioBucketName(project.slug, bucketName);

    // Generate using the internal client (minio:9000), then rewrite the host
    // to the public endpoint so the browser can reach it.
    const internalUrl = await this.client.presignedGetObject(minioBucket, objectName, expiry);

    const publicHost = this.publicSsl
      ? `https://${this.publicEndpoint}:${this.publicPort}`
      : `http://${this.publicEndpoint}:${this.publicPort}`;

    const parsed = new URL(internalUrl);
    const url = internalUrl.replace(`${parsed.protocol}//${parsed.host}`, publicHost);

    return { url, expiresIn: expiry };
  }

  // ── Helpers ────────────────────────────────────────────

  private async bucketStats(minioBucket: string) {
    let totalSize = 0;
    let objectCount = 0;

    return new Promise<{ totalSize: number; objectCount: number }>((resolve, reject) => {
      const stream = this.client.listObjectsV2(minioBucket, '', true);
      stream.on('data', (obj) => {
        totalSize += obj.size || 0;
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
}
