import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  BadRequestException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import * as Minio from 'minio';
import { StorageClientSet, buildStorageClients } from './storage-client.factory';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QuotaService } from '../billing/quota.service';
import { StorageCatalogService } from './storage-catalog.service';
import { downloadOnlyHeaders, withoutAnonymousListing } from './storage-public-safety';
import {
  PLATFORM_BUCKETS as PLATFORM_BUCKET_NAMES,
  classifyBucket,
  effectivePrefix,
  inOtherNamespace,
  isPlatformBucket,
  physicalBucketName as buildPhysicalName,
  physicalPrefix,
  platformPrefix,
} from './bucket-names';

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

/** One MinIO bucket as measured by the last full storage pass. */
export interface BucketInventoryEntry {
  bucket: string;
  /** Owning project of any status (a deleted project's leftovers still name it); null = none. */
  projectId: string | null;
  sizeBytes: number;
  objectCount: number;
  createdAt: string;
}

export interface BucketInventory {
  measuredAt: string;
  buckets: BucketInventoryEntry[];
}

/** SystemSetting key holding the latest {@link BucketInventory}. */
const BUCKET_INVENTORY_KEY = 'storage_bucket_inventory';

/** Platform-wide bucket for user feedback screenshots / clips (not project-scoped). */
const FEEDBACK_ATTACHMENTS_BUCKET = 'bf-platform-feedback';

/** Platform-wide bucket for marketing agency renders (voiceovers, cached art). */
const MARKETING_ASSETS_BUCKET = 'bf-platform-marketing';

/** Buckets the platform itself owns, as opposed to customer projects (see bucket-names.ts). */
export const PLATFORM_BUCKETS: readonly string[] = PLATFORM_BUCKET_NAMES;

/**
 * Told about bucket changes, so S3 key policies follow the project's buckets (feedback #225).
 * `beforeDelete` runs before the bucket is emptied and may refuse the delete by throwing: a key
 * policy that still named a deleted bucket could later reach a re-created bucket of the same
 * physical name. `afterCreate` failures are logged; the new bucket is then simply not reachable
 * by keys until the next policy write.
 */
export interface BucketChangeListener {
  beforeDelete(projectId: string, physical: string): Promise<void>;
  afterCreate(projectId: string, physical: string): Promise<void>;
}

const UNSUPPORTED_BUCKET_POLICIES =
  'This object store does not support anonymous bucket policies. Keep the bucket private and serve files through signed URLs or the download route.';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: Minio.Client;
  private publicClient: Minio.Client;
  private publicEndpoint: string;
  private publicPort: number;
  private publicSsl: boolean;
  /** Driver, addressing style and capabilities of the configured store. */
  private readonly caps: StorageClientSet;
  private readonly bucketListeners: BucketChangeListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quota: QuotaService,
    // Optional so the service can still be built by hand without a catalog;
    // every write below reports to it when it is there (see StorageCatalogService).
    @Optional() private readonly catalog?: StorageCatalogService,
  ) {
    // One place decides which store this is: MINIO_* by default, S3_* when
    // STORAGE_DRIVER=s3. Everything below only ever sees an S3 client.
    const set = buildStorageClients(this.config);
    this.caps = set;
    this.client = set.client;
    this.publicClient = set.publicClient;
    this.publicEndpoint = set.publicEndpoint;
    this.publicPort = set.publicPort;
    this.publicSsl = set.publicSsl;
  }

  /** Register for bucket create/delete events (S3 key policies). */
  addBucketListener(listener: BucketChangeListener): void {
    this.bucketListeners.push(listener);
  }

  /** `minio` or `s3`. */
  get driver(): StorageClientSet['driver'] {
    return this.caps.driver;
  }

  /** Physical names of platform-owned buckets start with this; no project may ever be granted one. */
  get platformBucketPrefix(): string {
    return platformPrefix(this.caps.bucketPrefix);
  }

  /** The physical prefix of a project's buckets, trailing hyphen included. */
  projectBucketPrefix(project: { slug: string; storagePrefix?: string | null }): string {
    return this.minioProjectPrefix(project.storagePrefix ?? project.slug);
  }

  /** Every physical bucket in the store. */
  async listPhysicalBucketNames(): Promise<string[]> {
    return (await this.client.listBuckets()).map((b) => b.name);
  }

  private minioBucketName(projectSlug: string, bucketName: string): string {
    return buildPhysicalName(this.caps.bucketPrefix, projectSlug, bucketName);
  }

  /**
   * Per-project storage figures arrived after many projects already existed.
   * Until every billable project has been measured once, run the storage pass
   * shortly after boot instead of waiting up to six hours for the cron.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log(`Storage driver: ${this.caps.describe()}`);
    this.scheduleListingClosure();
    if (this.caps.driver === 's3') {
      // Not fatal: a wrong credential or region shows up here instead of on
      // the first upload.
      try {
        await this.client.listBuckets();
      } catch (err: any) {
        this.logger.warn(`Object store probe failed (${this.caps.describe()}): ${err?.message ?? err}`);
      }
    }
    try {
      const unmeasured = await this.prisma.project.count({
        where: {
          status: { notIn: ['DELETED', 'DEACTIVATED'] },
          OR: [{ usage: null }, { usage: { storageCalculatedAt: null } }],
        },
      });
      if (unmeasured === 0) return;
      this.logger.log(`${unmeasured} project(s) have no storage measurement yet — scheduling a pass in 90s`);
      const timer = setTimeout(() => {
        this.recalculateStorageUsage().catch(() => {});
      }, 90_000);
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
    } catch (err: any) {
      this.logger.debug(`Storage bootstrap check skipped: ${err.message}`);
    }
  }

  /**
   * Prefix for every MinIO bucket that belongs to a project — must match the start
   * of {@link minioBucketName} for that slug (any logical bucket name).
   */
  private minioProjectPrefix(projectSlug: string): string {
    return physicalPrefix(this.caps.bucketPrefix, projectSlug);
  }

  /**
   * Shared MinIO: bucket `bf-warebnb-2-docs` starts with `bf-warebnb-` so it was
   * wrongly listed under slug `warebnb` as "2-docs" unless a sibling `warebnb-2`
   * row existed. Resolve owner by longest matching project prefix among all active projects.
   *
   * Usage accounting only (who is billed for unrecorded bytes). Never an access decision:
   * tenant routes use {@link ownedBucket}.
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
    const results: BucketSummary[] = [];

    for (const b of await this.ownedPhysicalBuckets(project)) {
      const stats = await this.bucketStats(b.physical);
      const isPublic = await this.isBucketPublic(b.physical);

      results.push({
        id: b.physical,
        name: b.name,
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

    const myPrefix = this.minioProjectPrefix(effectivePrefix(project));
    const minioBucket = this.minioBucketName(effectivePrefix(project), name);
    if (isPlatformBucket(minioBucket, myPrefix, this.caps.bucketPrefix)) {
      throw new ConflictException(`Bucket name "${name}" is reserved. Choose a different name.`);
    }

    const exists = await this.client.bucketExists(minioBucket);
    if (exists) throw new ConflictException(`Bucket "${name}" already exists`);

    // `bf-a-` + `b-x` is the same physical name as `bf-a-b-` + `x`: a name that lies in another
    // project's namespace (an equal or longer matching prefix, any status) is refused, so a new
    // bucket never lands where that project's names live.
    const everyProject = await this.allProjectPrefixes();
    if (inOtherNamespace(minioBucket, { id: project.id, physicalPrefix: myPrefix }, everyProject)) {
      throw new ConflictException(
        `Bucket name "${name}" overlaps another project's storage namespace. Choose a different name.`,
      );
    }

    // Checked before the bucket exists, so a store without bucket policies
    // does not end up with a private bucket the caller believes is public.
    if (isPublic) this.assertBucketPoliciesSupported();

    // The owner row is claimed before the bucket exists: it is the lock against a concurrent
    // create of the same physical name, and every later access is checked against it.
    const claimed = await this.claimBucketOwner(minioBucket, project.id, name);
    try {
      await this.client.makeBucket(minioBucket);
    } catch (err) {
      if (claimed) {
        await this.prisma.storageBucketOwner
          .deleteMany({ where: { physicalName: minioBucket, projectId: project.id } })
          .catch(() => undefined);
      }
      throw err;
    }

    if (isPublic) {
      await this.applyBucketPolicy(minioBucket, this.publicBucketPolicy(minioBucket));
    }

    this.logger.log(`Bucket "${minioBucket}" created (public=${isPublic})`);
    await this.catalog?.upsertBucket(projectId, { name, public: isPublic, owner: userId });
    for (const l of this.bucketListeners) {
      await l.afterCreate(projectId, minioBucket).catch((err: any) =>
        this.logger.warn(`Bucket listener after create of ${minioBucket} failed: ${err?.message ?? err}`),
      );
    }

    return {
      id: minioBucket,
      name,
      public: isPublic,
      createdAt: new Date().toISOString(),
      objectCount: 0,
      totalSize: 0,
    };
  }

  async deleteBucket(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    opts: { force?: boolean } = {},
  ) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = await this.ownedBucket(project, bucketName);

    // A bucket that still holds files is only deleted on an explicit `force`; checked before any
    // listener runs so a refused delete changes nothing.
    const objects = await this.listAllObjects(minioBucket);
    if (objects.length > 0 && !opts.force) {
      throw new ConflictException(
        `Bucket "${bucketName}" is not empty (${objects.length} object${objects.length === 1 ? '' : 's'}). Empty it first, or pass force=true to delete the bucket and every file in it.`,
      );
    }

    // S3 key policies drop the bucket first; a failure refuses the delete (see BucketChangeListener).
    for (const l of this.bucketListeners) await l.beforeDelete(projectId, minioBucket);

    // Remove all objects first (force only)
    if (objects.length > 0) {
      await this.client.removeObjects(minioBucket, objects.map((o) => o.name));
    }

    await this.client.removeBucket(minioBucket);
    this.logger.log(`Bucket "${minioBucket}" deleted`);
    await this.prisma.storageBucketOwner
      ?.deleteMany({ where: { physicalName: minioBucket, projectId } })
      .catch((err: any) => this.logger.warn(`Bucket owner record of ${minioBucket} not removed: ${err?.message ?? err}`));
    await this.catalog?.deleteBucket(projectId, bucketName);
    return { message: `Bucket "${bucketName}" deleted` };
  }

  /**
   * Record `projectId` as the creator of `physicalName`. True when this call wrote the row, false
   * when the row already named this project (a leftover of a bucket that is gone). A row naming
   * another project refuses the create.
   */
  private async claimBucketOwner(physicalName: string, projectId: string, name: string): Promise<boolean> {
    const taken = () =>
      new ConflictException(`Bucket name "${name}" overlaps another project's storage namespace. Choose a different name.`);
    const existing = await this.prisma.storageBucketOwner.findUnique({ where: { physicalName } });
    if (existing) {
      if (existing.projectId !== projectId) throw taken();
      return false;
    }
    try {
      await this.prisma.storageBucketOwner.create({ data: { physicalName, projectId } });
      return true;
    } catch (err: any) {
      if (err?.code === 'P2002') throw taken();
      throw err;
    }
  }

  // ── Bucket ownership (the single choke point) ──────────

  /** Every project of any status with its physical prefix: the legacy ambiguity check. */
  private async allProjectPrefixes(): Promise<Array<{ id: string; physicalPrefix: string }>> {
    const rows = await this.prisma.project.findMany({ select: { id: true, slug: true, storagePrefix: true } });
    return rows.map((p) => ({ id: p.id, physicalPrefix: this.minioProjectPrefix(effectivePrefix(p)) }));
  }

  /**
   * The physical bucket behind `bucketName` for this project, only when this project owns it
   * (see bucket-names.ts): recorded in storage_bucket_owners for this project, or unrecorded and
   * this project's prefix is the only project prefix the name starts with (recorded on the spot).
   * Another project's bucket, an ambiguous legacy bucket, a platform bucket and a missing bucket
   * all answer the same 404, so the answer says nothing about other tenants.
   *
   * Every tenant path that touches a bucket goes through here; never build the name yourself.
   */
  private async ownedBucket(
    project: { id: string; slug: string; storagePrefix?: string | null },
    bucketName: string,
  ): Promise<string> {
    const myPrefix = this.minioProjectPrefix(effectivePrefix(project));
    const physical = this.minioBucketName(effectivePrefix(project), bucketName);
    const me = { id: project.id, physicalPrefix: myPrefix };
    const notFound = () => new NotFoundException(`Bucket "${bucketName}" not found`);
    const refuse = (why: string) => {
      this.logger.warn(`Refused bucket "${physical}" to project ${project.id}: ${why}`);
      return notFound();
    };

    const row = await this.prisma.storageBucketOwner.findUnique({ where: { physicalName: physical } });
    const recorded = classifyBucket({ physical, project: me, bucketPrefix: this.caps.bucketPrefix, recordedOwner: row?.projectId });
    if (recorded.kind === 'platform') throw refuse('platform bucket');
    if (recorded.kind === 'foreign') throw refuse(`recorded for project ${recorded.ownerId}`);

    if (!(await this.client.bucketExists(physical))) throw notFound();
    if (recorded.kind === 'owned' && !recorded.record) return physical;

    const verdict = classifyBucket({
      physical,
      project: me,
      bucketPrefix: this.caps.bucketPrefix,
      allProjects: await this.allProjectPrefixes(),
    });
    if (verdict.kind !== 'owned') {
      throw refuse(verdict.kind === 'ambiguous' ? `ambiguous legacy bucket (${verdict.candidates.join(', ')})` : verdict.kind);
    }
    await this.backfillOwners([physical], project.id);
    return physical;
  }

  /** Lazy backfill of unambiguous legacy buckets; a failed write only costs a later re-check. */
  private async backfillOwners(physicalNames: string[], projectId: string): Promise<void> {
    if (!physicalNames.length) return;
    await this.prisma.storageBucketOwner
      .createMany({ data: physicalNames.map((physicalName) => ({ physicalName, projectId })), skipDuplicates: true })
      .catch((err: any) => this.logger.warn(`Bucket owner backfill for ${projectId} not written: ${err?.message ?? err}`));
  }

  /**
   * The physical buckets this project owns (same rule as {@link ownedBucket}), with their
   * logical names. Unrecorded unambiguous ones are recorded on the way.
   */
  private async ownedPhysicalBuckets(project: {
    id: string;
    slug: string;
    storagePrefix?: string | null;
  }): Promise<Array<{ physical: string; name: string; creationDate: Date }>> {
    const prefix = this.minioProjectPrefix(effectivePrefix(project));
    const mine = (await this.client.listBuckets()).filter((b) => b.name.startsWith(prefix));
    if (!mine.length) return [];
    const rows = await this.prisma.storageBucketOwner.findMany({
      where: { physicalName: { in: mine.map((b) => b.name) } },
      select: { physicalName: true, projectId: true },
    });
    const recorded = new Map(rows.map((r) => [r.physicalName, r.projectId]));
    const everyProject = mine.some((b) => !recorded.has(b.name)) ? await this.allProjectPrefixes() : [];
    const out: Array<{ physical: string; name: string; creationDate: Date }> = [];
    const backfill: string[] = [];
    for (const b of mine) {
      const v = classifyBucket({
        physical: b.name,
        project: { id: project.id, physicalPrefix: prefix },
        bucketPrefix: this.caps.bucketPrefix,
        recordedOwner: recorded.get(b.name),
        allProjects: everyProject,
      });
      if (v.kind !== 'owned') continue;
      if (v.record) backfill.push(b.name);
      out.push({ physical: b.name, name: b.name.substring(prefix.length), creationDate: b.creationDate });
    }
    await this.backfillOwners(backfill, project.id);
    return out;
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

    for (const b of await this.ownedPhysicalBuckets(project)) {
      const logical = b.name.trim().toLowerCase();
      if (!logical || keep.has(logical)) continue;

      try {
        await this.deleteBucket(projectId, undefined, logical, { force: true });
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
    const minioBucket = await this.ownedBucket(project, bucketName);

    if (isPublic) {
      this.assertBucketPoliciesSupported();
      await this.applyBucketPolicy(minioBucket, this.publicBucketPolicy(minioBucket));
    } else if (this.caps.supportsBucketPolicies) {
      // A store without policies never had a public bucket; nothing to clear.
      await this.applyBucketPolicy(minioBucket, '');
    }

    await this.catalog?.setBucketPublic(projectId, bucketName, isPublic);
    return { public: isPublic };
  }

  /**
   * The project's buckets by name, without the per-bucket statistics that make
   * {@link listBuckets} walk every object. For callers that need the names and
   * nothing more (the Supabase-compatible `GET /bucket`).
   */
  async listBucketNames(
    projectId: string,
    userId?: string,
  ): Promise<Array<{ name: string; physical: string; createdAt: string }>> {
    const project = await this.assertProjectAccess(projectId, userId);
    return (await this.ownedPhysicalBuckets(project)).map((b) => ({
      name: b.name,
      physical: b.physical,
      createdAt: b.creationDate.toISOString(),
    }));
  }

  /**
   * Anonymous read policy for a public bucket: GetObject, so each file opens at its
   * direct URL. Not ListBucket: making a bucket public shares its files, not an
   * index of every key in it (feedback #9).
   */
  private publicBucketPolicy(minioBucket: string): string {
    return JSON.stringify({
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
  }

  /**
   * Public buckets made before the policy above also granted anonymous ListBucket. Remove
   * that statement and keep everything else, so files stay readable at their URLs.
   * Idempotent and safe on every replica; a bucket that fails is logged and left as it was.
   */
  async closeAnonymousListings(): Promise<{ checked: number; closed: number }> {
    let checked = 0;
    let closed = 0;
    const buckets = await this.client.listBuckets();
    for (const b of buckets) {
      checked++;
      try {
        const policy = await this.client.getBucketPolicy(b.name).catch(() => '');
        if (!policy) continue;
        const next = withoutAnonymousListing(policy);
        if (next == null) continue;
        const hasStatements = (JSON.parse(next).Statement ?? []).length > 0;
        await this.client.setBucketPolicy(b.name, hasStatements ? next : '');
        closed++;
      } catch (err: any) {
        this.logger.warn(`Could not close anonymous listing on bucket ${b.name}: ${err?.message ?? err}`);
      }
    }
    if (closed) this.logger.log(`Anonymous listing closed on ${closed} of ${checked} bucket(s)`);
    return { checked, closed };
  }

  /** A minute after boot, off the request path: see closeAnonymousListings. */
  private scheduleListingClosure(): void {
    const timer = setTimeout(() => {
      this.closeAnonymousListings().catch((err) => this.logger.warn(`Listing closure skipped: ${err?.message ?? err}`));
    }, 60_000);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
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
    const minioBucket = await this.ownedBucket(project, bucketName);

    return new Promise((resolve, reject) => {
      const objects: StorageObject[] = [];
      const stream = this.client.listObjectsV2(minioBucket, prefix, recursive);
      stream.on('data', (obj) => {
        // Skip the folder's own zero-byte marker (its key equals the prefix
        // being listed, or ends in '/') so it doesn't show as an empty file.
        if (obj.name && (obj.name === prefix || obj.name.endsWith('/'))) return;
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
    const minioBucket = await this.ownedBucket(project, bucketName);

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
    // Each segment encoded: a key with #, ? or a space is a different URL otherwise (a # cut it short).
    const clean = (path || '')
      .replace(/^\/+/, '')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    // Virtual-host addressing (AWS without path-style) carries the bucket in the host.
    return this.caps.virtualHost
      ? `${scheme}://${minioBucket}.${host}/${clean}`
      : `${scheme}://${host}/${minioBucket}/${clean}`;
  }

  /** Which store this is and what it can do — for routes that must adapt (e.g. refuse "public" on R2). */
  get capabilities(): Pick<StorageClientSet, 'driver' | 'supportsBucketPolicies' | 'virtualHost' | 'bucketPrefix'> {
    const { driver, supportsBucketPolicies, virtualHost, bucketPrefix } = this.caps;
    return { driver, supportsBucketPolicies, virtualHost, bucketPrefix };
  }

  private assertBucketPoliciesSupported(): void {
    if (!this.caps.supportsBucketPolicies) {
      throw new BadRequestException(UNSUPPORTED_BUCKET_POLICIES);
    }
  }

  /** `setBucketPolicy`, with a store that lacks the call reported as a clear 400 instead of a 500. */
  private async applyBucketPolicy(minioBucket: string, policy: string): Promise<void> {
    try {
      await this.client.setBucketPolicy(minioBucket, policy);
    } catch (err: any) {
      const code = String(err?.code ?? '');
      if (code === 'NotImplemented' || code === 'MethodNotAllowed' || code === 'NotSupported') {
        throw new BadRequestException(UNSUPPORTED_BUCKET_POLICIES);
      }
      throw err;
    }
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
    const minioBucket = await this.ownedBucket(project, bucketName);
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
    const minioBucket = await this.ownedBucket(project, bucketName);
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

  private listKeysUnder(minioBucket: string, prefix: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.client.listObjectsV2(minioBucket, prefix, true);
      stream.on('data', (o) => {
        if (o.name) keys.push(o.name);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(keys));
    });
  }

  /**
   * Move files and/or whole folders into a destination folder (S3 has no native
   * move — this is copy + delete). A source ending in '/' is a folder and is
   * moved with its contents, keeping its name. destFolder '' means the bucket
   * root. Same-bucket move, so storage quota is unchanged.
   */
  async moveObjects(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    sources: string[],
    destFolder: string,
  ): Promise<{ moved: number }> {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = await this.ownedBucket(project, bucketName);

    const destRaw = (destFolder || '').replace(/^\/+/, '');
    if (destRaw.includes('..')) throw new BadRequestException('Invalid destination');
    const dest = destRaw && !destRaw.endsWith('/') ? `${destRaw}/` : destRaw;

    // Plan every move first, so a missing source or a name clash is refused
    // before a single object has been touched (no half-done batch).
    const plan: Array<{ from: string; to: string }> = [];
    for (const raw of sources || []) {
      const src = (raw || '').replace(/^\/+/, '');
      if (!src) continue;

      if (src.endsWith('/')) {
        const folderName = src.replace(/\/$/, '').split('/').pop() || '';
        const newBase = `${dest}${folderName}/`;
        if (newBase === src) continue; // already there
        if (newBase.startsWith(src)) {
          throw new BadRequestException('Cannot move a folder into itself');
        }
        const keys = await this.listKeysUnder(minioBucket, src);
        if (keys.length === 0) throw new NotFoundException(`Folder "${src}" not found`);
        for (const key of keys) plan.push({ from: key, to: `${newBase}${key.slice(src.length)}` });
      } else {
        const filename = src.split('/').pop() || src;
        const newKey = `${dest}${filename}`;
        if (newKey === src) continue;
        if (!(await this.statObjectIn(minioBucket, src))) {
          throw new NotFoundException(`Object "${src}" not found`);
        }
        plan.push({ from: src, to: newKey });
      }
    }
    const movingFrom = new Set(plan.map((m) => m.from));
    for (const m of plan) {
      if (!movingFrom.has(m.to) && (await this.statObjectIn(minioBucket, m.to))) {
        throw new ConflictException(`An object already exists at "${m.to}"`);
      }
    }

    let moved = 0;
    for (const { from, to } of plan) {
      // minio 8 keeps the (target, object, source) string overload at runtime;
      // cast past the ambiguous overload typing.
      await (this.client.copyObject as any)(minioBucket, to, `/${minioBucket}/${from}`);
      await this.client.removeObject(minioBucket, from);
      await this.catalog?.moveObject(projectId, bucketName, from, to);
      moved++;
    }

    this.logger.log(`Moved ${moved} object(s) to "${dest || '/'}" in "${minioBucket}"`);
    return { moved };
  }

  /**
   * Rename one object to an exact key, optionally into another bucket of the
   * same project (copy + delete; S3 has no native move). Unlike
   * {@link moveObjects}, the destination is the whole key, not a folder.
   */
  async moveObject(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    sourceKey: string,
    destinationKey: string,
    destinationBucket: string = bucketName,
  ): Promise<{ name: string }> {
    const project = await this.assertProjectAccess(projectId, userId);
    const src = this.cleanKey(sourceKey, 'source');
    const dest = this.cleanKey(destinationKey, 'destination');
    const srcPhysical = await this.ownedBucket(project, bucketName);
    const destPhysical =
      destinationBucket === bucketName ? srcPhysical : await this.ownedBucket(project, destinationBucket);
    if (srcPhysical === destPhysical && src === dest) return { name: dest };
    await this.copyObjectIn(srcPhysical, src, destPhysical, dest);
    await this.client.removeObject(srcPhysical, src);
    await this.catalog?.moveObject(projectId, bucketName, src, dest, destinationBucket);
    return { name: dest };
  }

  /** Duplicate one object under another key, optionally into another bucket of the same project. */
  async copyObject(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    sourceKey: string,
    destinationKey: string,
    destinationBucket: string = bucketName,
    meta: Record<string, string> = {},
  ): Promise<{ name: string; size: number; etag?: string; id?: string }> {
    const project = await this.assertProjectAccess(projectId, userId);
    const src = this.cleanKey(sourceKey, 'source');
    const dest = this.cleanKey(destinationKey, 'destination');
    const srcPhysical = await this.ownedBucket(project, bucketName);
    const destPhysical =
      destinationBucket === bucketName ? srcPhysical : await this.ownedBucket(project, destinationBucket);
    const source = await this.statObjectIn(srcPhysical, src);
    if (!source) throw new NotFoundException(`Object "${src}" not found`);
    await this.quota.assertCanUploadStorage(project.teamId, source.size);
    await this.copyObjectIn(srcPhysical, src, destPhysical, dest);
    const stat = (await this.statObjectIn(destPhysical, dest)) ?? source;
    const id = await this.catalog?.recordUpload(
      projectId,
      destinationBucket,
      dest,
      stat,
      (stat.metaData?.['content-type'] as string | undefined) || 'application/octet-stream',
      meta,
    );
    return { name: dest, size: stat.size, etag: stat.etag, id };
  }

  /** A read of `..` or a NUL is a bad request, not a store error (500). Names that merely contain two dots are fine. */
  private assertReadableKey(objectName: string): void {
    const key = String(objectName ?? '');
    if (!key || key.includes('\0') || key.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new BadRequestException('Invalid object path');
    }
  }

  private cleanKey(raw: string, what: string): string {
    const key = (raw || '').replace(/^\/+/, '');
    if (!key || key.includes('..') || key.includes('\0')) throw new BadRequestException(`Invalid ${what} key`);
    return key;
  }

  /** Server-side copy between physical buckets of the same store. */
  async copyObjectIn(srcPhysical: string, srcKey: string, destPhysical: string, destKey: string): Promise<void> {
    await (this.client.copyObject as any)(destPhysical, destKey, `/${srcPhysical}/${srcKey}`);
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

    const minioBucket = await this.ownedBucket(project, bucketName);

    const objectName = path.replace(/^\/+/, '');

    await this.client.putObject(minioBucket, objectName, buffer, buffer.length, {
      'Content-Type': contentType,
      ...downloadOnlyHeaders(contentType),
    });

    this.logger.log(`Uploaded "${objectName}" to "${minioBucket}"`);

    const stat = await this.client.statObject(minioBucket, objectName);
    const id = await this.catalog?.recordUpload(projectId, bucketName, objectName, stat, contentType, undefined);
    return {
      name: objectName,
      size: stat.size,
      contentType: stat.metaData?.['content-type'] || contentType,
      lastModified: stat.lastModified,
      etag: stat.etag,
      id,
    };
  }

  /**
   * Same as {@link uploadObject}, but the body streams straight through to
   * storage instead of being held in memory.
   *
   * Buffering is fine for a dashboard upload and fatal for a bulk import: this
   * container is capped at 2 GiB, so a handful of concurrent 500 MB objects
   * would exhaust the heap and take the whole API down mid-import. `size` comes
   * from the source listing — MinIO needs it up front to avoid buffering the
   * stream itself, which would defeat the purpose.
   */
  async uploadObjectStream(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    path: string,
    body: Readable,
    size: number,
    contentType: string,
    meta: Record<string, string> = {},
    knownEmpty = false,
  ) {
    if (!path || path === '/') {
      throw new BadRequestException('File path is required');
    }

    const project = await this.assertProjectAccess(projectId, userId);
    await this.quota.assertCanUploadStorage(project.teamId, size);

    const minioBucket = await this.ownedBucket(project, bucketName);

    const objectName = path.replace(/^\/+/, '');

    // A zero here would be taken literally and store an empty object — the file
    // would exist, the count would match, and the loss would be invisible. When
    // the source does not declare a length, hand the client no length at all and
    // let it read the stream to the end.
    const declared = Number.isFinite(size) && size > 0 ? size : undefined;

    // A source that is known to be empty is stored as a real zero-byte object;
    // the streaming path cannot upload an empty stream.
    const empty = knownEmpty && size === 0;
    if (empty) body.destroy();
    await this.client.putObject(minioBucket, objectName, empty ? Buffer.alloc(0) : body, empty ? 0 : (declared as number), {
      'Content-Type': contentType,
      ...meta,
      ...downloadOnlyHeaders(contentType),
    });

    const stat = await this.client.statObject(minioBucket, objectName);

    // Read back what landed. A truncated upload otherwise counts as a success.
    if (empty ? stat.size !== 0 : declared !== undefined && stat.size !== declared) {
      throw new InternalServerErrorException(
        `Upload of "${objectName}" stored ${stat.size} bytes, expected ${empty ? 0 : declared}`,
      );
    }
    const id = await this.catalog?.recordUpload(projectId, bucketName, objectName, stat, contentType, meta);
    return {
      name: objectName,
      size: stat.size,
      contentType: stat.metaData?.['content-type'] || contentType,
      lastModified: stat.lastModified,
      etag: stat.etag,
      id,
    };
  }

  async getObject(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    objectName: string,
  ): Promise<{ stream: Readable; stat: Minio.BucketItemStat }> {
    this.assertReadableKey(objectName);
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = await this.ownedBucket(project, bucketName);

    try {
      const stat = await this.client.statObject(minioBucket, objectName);
      const stream = await this.client.getObject(minioBucket, objectName);
      return { stream, stat };
    } catch (err: any) {
      if (err.code === 'NotFound' || err.code === 'NoSuchKey') {
        throw new NotFoundException(`Object "${objectName}" not found`);
      }
      if (err.code === 'NoSuchBucket') throw new NotFoundException('Bucket not found');
      this.logger.error(`getObject failed on ${minioBucket}: ${err.message}`);
      throw new InternalServerErrorException('Failed to get object');
    }
  }

  /**
   * Like {@link getObject}, but only `length` bytes from `offset` — what a
   * `Range` request for a video or a resumed download needs. The stat is the
   * whole object's, so the caller can write Content-Range from it.
   */
  async getPartialObject(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    objectName: string,
    offset: number,
    length?: number,
  ): Promise<{ stream: Readable; stat: Minio.BucketItemStat }> {
    this.assertReadableKey(objectName);
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = await this.ownedBucket(project, bucketName);
    return this.getObjectIn(minioBucket, objectName, { offset, length });
  }

  /**
   * The bytes of one object in a physical bucket the caller already resolved,
   * whole or as a range. Missing → 404.
   */
  async getObjectIn(
    minioBucket: string,
    objectName: string,
    range?: { offset: number; length?: number },
  ): Promise<{ stream: Readable; stat: Minio.BucketItemStat }> {
    try {
      const stat = await this.client.statObject(minioBucket, objectName);
      const stream = range
        ? await this.client.getPartialObject(minioBucket, objectName, range.offset, range.length)
        : await this.client.getObject(minioBucket, objectName);
      return { stream, stat };
    } catch (err: any) {
      if (err.code === 'NotFound' || err.code === 'NoSuchKey') {
        throw new NotFoundException(`Object "${objectName}" not found`);
      }
      if (err.code === 'NoSuchBucket') throw new NotFoundException('Bucket not found');
      this.logger.error(`getObject failed on ${minioBucket}: ${err.message}`);
      throw new InternalServerErrorException('Failed to get object');
    }
  }

  /** Objects directly under `prefix` in a physical bucket (folder markers skipped). */
  listObjectsIn(minioBucket: string, prefix = '', recursive = false): Promise<StorageObject[]> {
    return new Promise((resolve, reject) => {
      const objects: StorageObject[] = [];
      const stream = this.client.listObjectsV2(minioBucket, prefix, recursive);
      stream.on('data', (obj) => {
        if (obj.name && (obj.name === prefix || obj.name.endsWith('/'))) return;
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

  /** Remove exact keys from a physical bucket; nothing is expanded. */
  async removeObjectsIn(minioBucket: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.removeObjects(minioBucket, [...keys]);
  }

  async deleteObjects(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    objectNames: string[],
    options: { expandFolders?: boolean; onlyExisting?: boolean } = {},
  ) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = await this.ownedBucket(project, bucketName);
    const expandFolders = options.expandFolders ?? true;
    // The count in the answer is of objects that were there; a caller that already
    // checked passes onlyExisting: false to skip the second look.
    const onlyExisting = options.onlyExisting ?? true;

    // Expand any folder paths (ending in '/') into all the objects beneath them
    // so selecting a folder deletes its whole contents.
    const keys = new Set<string>();
    for (const raw of objectNames || []) {
      const name = (raw || '').replace(/^\/+/, '');
      if (!name) continue;
      if (name.endsWith('/') && expandFolders) {
        for (const k of await this.listKeysUnder(minioBucket, name)) keys.add(k);
      } else if (!onlyExisting || (await this.statObjectIn(minioBucket, name))) {
        keys.add(name);
      }
    }

    const all = Array.from(keys);
    await this.client.removeObjects(minioBucket, all);
    this.logger.log(`Deleted ${all.length} object(s) from "${minioBucket}"`);
    await this.catalog?.deleteObjects(projectId, bucketName, all);
    return { message: `Deleted ${all.length} object(s)` };
  }

  async getPresignedUrl(
    projectId: string,
    userId: string | undefined,
    bucketName: string,
    objectName: string,
    expiry = 3600,
  ) {
    this.assertReadableKey(objectName);
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = await this.ownedBucket(project, bucketName);

    // Important: generate the signed URL using the public endpoint client directly.
    // Rewriting host/port after signing can invalidate the signature in production.
    const url = await this.publicClient.presignedGetObject(minioBucket, objectName, expiry);

    return { url, expiresIn: expiry };
  }

  // ── For sibling services (upload sessions, access rules) ─

  /** Project access check for routes implemented outside this service. */
  async resolveProject(projectId: string, userId?: string) {
    return this.assertProjectAccess(projectId, userId);
  }

  /**
   * Project access check plus bucket ownership and existence; returns the physical bucket name
   * too. A bucket this project does not own answers 404 (see {@link ownedBucket}).
   */
  async resolveBucket(projectId: string, userId: string | undefined, bucketName: string) {
    const project = await this.assertProjectAccess(projectId, userId);
    const minioBucket = await this.ownedBucket(project, bucketName);
    return { project, minioBucket };
  }

  /**
   * Physical bucket for a project row already at hand (no membership check), with the same
   * ownership check as {@link resolveBucket}. For upload sessions resumed by id.
   */
  resolveProjectBucket(
    project: { id: string; slug: string; storagePrefix?: string | null },
    bucketName: string,
  ): Promise<string> {
    return this.ownedBucket(project, bucketName);
  }

  bucketIsPublic(minioBucket: string): Promise<boolean> {
    return this.isBucketPublic(minioBucket);
  }

  /** `statObject` that answers null for a missing key instead of throwing. */
  async statObjectIn(minioBucket: string, key: string): Promise<Minio.BucketItemStat | null> {
    try {
      return await this.client.statObject(minioBucket, key);
    } catch (err: any) {
      if (err?.code === 'NotFound' || err?.code === 'NoSuchKey') return null;
      throw err;
    }
  }

  // Native multipart primitives behind the resumable upload sessions. The
  // session row tracks the parts; the client library keeps listParts protected.

  beginMultipart(minioBucket: string, key: string, headers: Record<string, string>): Promise<string> {
    return this.client.initiateNewMultipartUpload(minioBucket, key, headers);
  }

  async putPart(minioBucket: string, key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    const res = await this.client.uploadPart(
      { bucketName: minioBucket, objectName: key, uploadID: uploadId, partNumber, headers: {} },
      body,
    );
    return res.etag;
  }

  async finishMultipart(
    minioBucket: string,
    key: string,
    uploadId: string,
    parts: { part: number; etag: string }[],
  ): Promise<void> {
    await this.client.completeMultipartUpload(minioBucket, key, uploadId, parts);
  }

  async abortMultipart(minioBucket: string, key: string, uploadId: string): Promise<void> {
    try {
      await this.client.abortMultipartUpload(minioBucket, key, uploadId);
    } catch (err: any) {
      if (err?.code === 'NoSuchUpload' || err?.code === 'NotFound') return;
      throw err;
    }
  }

  // ── Usage accounting ───────────────────────────────────

  /**
   * Recompute `team_usage.storage_bytes` from what MinIO actually holds.
   *
   * The column was only ever initialised to zero and never written again, so
   * every team read as "0 GB used": the dashboard under-reported, and
   * `assertCanUploadStorage` could not trip because the running total never
   * left zero. Storage is the only component that can answer the question, so
   * it reports its own usage instead of routing a dependency from billing back
   * into here.
   *
   * Deactivated and deleted projects are excluded, matching the existing rule
   * that a frozen project does not consume the plan's quota.
   *
   * @param teamId Limit the pass to one team — used right after an import so
   *   the figure is current instead of up to six hours stale.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async recalculateStorageUsage(teamId?: string): Promise<void> {
    try {
      const projects = await this.prisma.project.findMany({
        where: {
          status: { notIn: ['DELETED', 'DEACTIVATED'] },
          ...(teamId ? { teamId } : {}),
        },
        select: { id: true, slug: true, storagePrefix: true, teamId: true },
      });
      if (projects.length === 0) return;

      const teamByProject = new Map(projects.map((p) => [p.id, p.teamId]));

      // Every team in scope starts at zero, so a team whose buckets were all
      // removed drops to zero instead of keeping its last non-zero total.
      const bytesByTeam = new Map<string, bigint>(
        projects.map((p) => [p.teamId, BigInt(0)]),
      );
      const bytesByProject = new Map<string, bigint>(projects.map((p) => [p.id, BigInt(0)]));

      // A full pass also records every bucket — including those of deleted
      // projects and the platform's own — for the root console's inventory.
      const fullPass = !teamId;
      const everyProject = fullPass
        ? await this.prisma.project.findMany({ select: { id: true, slug: true, storagePrefix: true } })
        : [];
      const inventory: BucketInventoryEntry[] = [];

      // A recorded owner wins over the name: `bf-a-b-x` may be project a's even when a-b exists.
      const recorded = new Map(
        (await this.prisma.storageBucketOwner.findMany({ select: { physicalName: true, projectId: true } })).map(
          (r) => [r.physicalName, r.projectId] as const,
        ),
      );
      const projectById = new Map(projects.map((p) => [p.id, p]));

      const buckets = await this.client.listBuckets();
      for (const bucket of buckets) {
        const rec = recorded.get(bucket.name);
        const owner =
          rec !== undefined ? (projectById.get(rec) ?? null) : this.resolveMinioBucketOwner(bucket.name, projects);
        const team = owner ? teamByProject.get(owner.id) : undefined;
        if (!team && !fullPass) continue;
        const { totalSize, objectCount } = await this.bucketStats(bucket.name);
        if (owner && team) {
          bytesByTeam.set(team, (bytesByTeam.get(team) ?? BigInt(0)) + BigInt(totalSize));
          bytesByProject.set(owner.id, (bytesByProject.get(owner.id) ?? BigInt(0)) + BigInt(totalSize));
        }
        if (fullPass) {
          const anyOwner = owner ?? (rec !== undefined ? { id: rec } : this.resolveMinioBucketOwner(bucket.name, everyProject));
          inventory.push({
            bucket: bucket.name,
            projectId: anyOwner?.id ?? null,
            sizeBytes: totalSize,
            objectCount,
            createdAt: bucket.creationDate.toISOString(),
          });
        }
      }

      if (fullPass) {
        const value: BucketInventory = { measuredAt: new Date().toISOString(), buckets: inventory };
        await this.prisma.systemSetting.upsert({
          where: { key: BUCKET_INVENTORY_KEY },
          create: { key: BUCKET_INVENTORY_KEY, value: value as unknown as Prisma.InputJsonValue },
          update: { value: value as unknown as Prisma.InputJsonValue },
        });
      }

      for (const [team, bytes] of bytesByTeam) {
        await this.prisma.teamUsage.upsert({
          where: { teamId: team },
          update: { storageBytes: bytes },
          create: { teamId: team, storageBytes: bytes },
        });
      }

      // Per-project figures feed the cost breakdown under Billing.
      const measuredAt = new Date();
      for (const p of projects) {
        const bytes = bytesByProject.get(p.id) ?? BigInt(0);
        await this.prisma.projectUsage.upsert({
          where: { projectId: p.id },
          update: { storageBytes: bytes, storageCalculatedAt: measuredAt, teamId: p.teamId },
          create: { projectId: p.id, teamId: p.teamId, storageBytes: bytes, storageCalculatedAt: measuredAt },
        });
      }

      this.logger.log(
        `Storage usage recalculated for ${bytesByTeam.size} team(s)` +
          (teamId ? ` (team ${teamId})` : ''),
      );
    } catch (err: any) {
      // Usage accounting must never take down a request or an import.
      this.logger.warn(`Storage usage recalculation failed: ${err.message}`);
    }
  }

  /** Every bucket as of the last full storage pass; null until one has run. */
  async getBucketInventory(): Promise<BucketInventory | null> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: BUCKET_INVENTORY_KEY } });
    return (row?.value as unknown as BucketInventory) ?? null;
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

  /**
   * Stores a marketing agency render and returns a publicly readable URL.
   *
   * fal.ai hands back hosted URLs, but ElevenLabs returns raw audio bytes — and
   * Pubbler will only attach media it can fetch over HTTP. Parking the bytes in a
   * public platform bucket gives the voiceover the same kind of URL the images
   * already have, so the rest of the pipeline treats every asset the same way.
   */
  async uploadMarketingAsset(
    campaignId: string,
    buffer: Buffer,
    contentType: string,
    extension: string,
  ): Promise<{ url: string }> {
    const bucket = MARKETING_ASSETS_BUCKET;
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

    const objectName = `${campaignId}/${Date.now()}-${randomBytes(8).toString('hex')}.${extension}`;
    await this.client.putObject(bucket, objectName, buffer, buffer.length, {
      'Content-Type': contentType,
    });

    const publicHost = this.publicSsl
      ? `https://${this.publicEndpoint}:${this.publicPort}`
      : `http://${this.publicEndpoint}:${this.publicPort}`;
    return { url: `${publicHost}/${bucket}/${objectName}` };
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
