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
  private publicEndpoint: string;
  private publicPort: number;
  private publicSsl: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.client = new Minio.Client({
      endPoint: this.config.get<string>('minio.endpoint') || 'localhost',
      port: this.config.get<number>('minio.port') || 9000,
      useSSL: this.config.get<boolean>('minio.useSsl') || false,
      accessKey: this.config.get<string>('minio.accessKey') || 'kolaybase',
      secretKey: this.config.get<string>('minio.secretKey') || 'kolaybase_secret',
    });

    this.publicEndpoint = this.config.get<string>('minio.publicEndpoint') || 'localhost';
    this.publicPort = this.config.get<number>('minio.publicPort') || 9000;
    this.publicSsl = this.config.get<string>('minio.publicSsl') === 'true';
  }

  private minioBucketName(projectSlug: string, bucketName: string): string {
    return `kb-${projectSlug}-${bucketName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  private async assertProjectAccess(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership) throw new ForbiddenException('Not a member of this team');

    return project;
  }

  // ── Bucket operations ──────────────────────────────────

  async listBuckets(projectId: string, userId: string): Promise<BucketSummary[]> {
    const project = await this.assertProjectAccess(projectId, userId);
    const prefix = `kb-${project.slug}-`;

    const allBuckets = await this.client.listBuckets();
    const projectBuckets = allBuckets.filter((b) => b.name.startsWith(prefix));

    const results: BucketSummary[] = [];

    for (const b of projectBuckets) {
      const displayName = b.name.slice(prefix.length);
      const stats = await this.bucketStats(b.name);

      results.push({
        id: b.name,
        name: displayName,
        public: false,
        createdAt: b.creationDate.toISOString(),
        objectCount: stats.objectCount,
        totalSize: stats.totalSize,
      });
    }

    return results;
  }

  async createBucket(projectId: string, userId: string, name: string, isPublic = false) {
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

  async deleteBucket(projectId: string, userId: string, bucketName: string) {
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

  async toggleBucketPublic(projectId: string, userId: string, bucketName: string, isPublic: boolean) {
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
    userId: string,
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
    userId: string,
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
    userId: string,
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
    userId: string,
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
    userId: string,
    bucketName: string,
    objectName: string,
    expiry = 3600,
  ) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = this.minioBucketName(project.slug, bucketName);
    const internalUrl = await this.client.presignedGetObject(minioBucket, objectName, expiry);

    const parsed = new URL(internalUrl);
    parsed.protocol = this.publicSsl ? 'https:' : 'http:';
    parsed.hostname = this.publicEndpoint;
    parsed.port = this.publicSsl && this.publicPort === 443 ? '' : String(this.publicPort);

    return { url: parsed.toString(), expiresIn: expiry };
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
