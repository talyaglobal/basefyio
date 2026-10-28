import { ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { Readable } from 'stream';
import { PrismaService } from '../../prisma/prisma.service';
import type { ApiKeyPayload } from '../../common/guards/api-key.guard';
import { ProjectDbRole, ProjectRlsRunner } from '../project-db/project-rls-runner';
import { mapPgError } from '../projects/pg-error.util';
import { ImageTransformService } from '../storage/image-transform.service';
import { StorageAccessService } from '../storage/storage-access.service';
import { StorageCaller, isPrivileged, ownerTag, storageCaller } from '../storage/storage-caller';
import { StorageCatalogService } from '../storage/storage-catalog.service';
import {
  CatalogBucketRow,
  CatalogObjectRow,
  USER_METADATA_HEADER,
  objectMetadata,
} from '../storage/storage-catalog.sql';
import { StorageService } from '../storage/storage.service';
import { StorageFacadeError } from './storage-facade.errors';
import {
  StatLike,
  contentDisposition,
  fileObjectFromStat,
  folderObject,
  objectInfo,
  parseRange,
  syntheticObjectId,
  transformClaimFromOptions,
} from './storage-facade.util';
import {
  FileObject,
  ListOptions,
  ListRow,
  applyListOptions,
  buildListQuery,
  fileObjectFromRow,
  normaliseListOptions,
} from './storage-list.sql';
import { StorageSigningService } from './storage-signing.service';

export type StorageAuthzMode = 'presets' | 'rls';

export interface FacadeProject {
  id: string;
  slug: string;
  storagePrefix: string | null;
  teamId: string;
  status: string;
  keycloakRealm: string;
  serviceKey: string;
  storageAuthz: StorageAuthzMode;
}

/** Who is asking, in the two vocabularies the facade needs: the preset rules' and Postgres's. */
export interface FacadeCaller {
  caller: StorageCaller;
  role: ProjectDbRole;
  jwtClaims?: Record<string, unknown>;
}

export interface UploadInput {
  body: Readable | Buffer;
  /** Declared length; undefined streams to the end. */
  size?: number;
  contentType: string;
  cacheControl?: string;
  userMetadata?: Record<string, unknown>;
}

export interface UploadOptions {
  upsert: boolean;
  /** Owner recorded on the object; defaults to the caller's identity. */
  owner?: string;
}

export interface ByteSource {
  stream: Readable;
  stat: StatLike;
  range: { start: number; end: number } | null;
}

export interface SupabaseBucket {
  id: string;
  name: string;
  owner: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
  created_at: string;
  updated_at: string;
}

const ANON_CALLER: FacadeCaller = { caller: { kind: 'anon' }, role: 'anon' };

const DRY_INSERT_SQL = `
  INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, user_metadata, version)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;
const DRY_UPSERT_SQL = `${DRY_INSERT_SQL}
  ON CONFLICT (bucket_id, name) DO UPDATE SET
    owner = EXCLUDED.owner, owner_id = EXCLUDED.owner_id, metadata = EXCLUDED.metadata,
    user_metadata = EXCLUDED.user_metadata, version = EXCLUDED.version, updated_at = now()`;
const RLS_SELECT_SQL = `
  SELECT id, bucket_id, name, owner, owner_id, metadata, user_metadata, version,
         created_at, updated_at, last_accessed_at
  FROM storage.objects WHERE bucket_id = $1 AND name = $2`;
const RLS_DELETE_SQL = `
  DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[])
  RETURNING name, id, updated_at, created_at, last_accessed_at, metadata`;
const RLS_MOVE_SQL = `
  UPDATE storage.objects SET bucket_id = $3, name = $4, updated_at = now(), last_accessed_at = now()
  WHERE bucket_id = $1 AND name = $2 RETURNING id`;
const RLS_BUCKETS_SQL = `
  SELECT id, name, owner, owner_id, public, file_size_limit, allowed_mime_types, created_at, updated_at
  FROM storage.buckets`;

/**
 * What the Supabase Storage routes do, independent of how a request reached
 * them: the guarded `storage/v1` controller, the public one and the signed
 * routes all call in here with the project and the caller they resolved.
 *
 * Authorisation has two modes, chosen per project by `Project.storageAuthz`:
 *
 *  - `rls`      the operation is first tried as a statement on the project's
 *               `storage.objects` under the caller's database role (a dry run
 *               for writes, rolled back), so the project's own policies — the
 *               ones a Supabase app ships with — decide. Only then is the
 *               object store touched.
 *  - `presets`  the StoragePolicy access rules (public-read /
 *               authenticated-read / owner-only) that existing projects use.
 *
 * Nothing holds a database transaction while bytes stream; the store is
 * always written or read after the decision.
 */
@Injectable()
export class StorageFacadeService {
  private readonly logger = new Logger(StorageFacadeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly access: StorageAccessService,
    private readonly catalog: StorageCatalogService,
    private readonly runner: ProjectRlsRunner,
    private readonly signing: StorageSigningService,
    private readonly transforms: ImageTransformService,
  ) {}

  // ── Who and what ────────────────────────────────────────

  /** The project a request names; deactivated projects are returned so the caller may wake them. */
  async loadProject(projectId: string): Promise<FacadeProject> {
    const row = await this.prisma.project.findFirst({
      where: { id: projectId, status: { in: ['ACTIVE', 'PAUSED'] } },
      select: {
        id: true,
        slug: true,
        storagePrefix: true,
        teamId: true,
        status: true,
        keycloakRealm: true,
        serviceKey: true,
        storageAuthz: true,
      },
    });
    if (!row) throw new StorageFacadeError({ statusCode: '404', error: 'not_found', message: 'Project not found' });
    return { ...row, storageAuthz: row.storageAuthz === 'rls' ? 'rls' : 'presets' };
  }

  /** The caller as the API key guard left it on the request. */
  callerOf(req: Request): FacadeCaller {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) return ANON_CALLER;
    return { caller: storageCaller(req), role: payload.dbRole, jwtClaims: payload.jwtClaims };
  }

  /**
   * The project of a keyed request. When the URL also named a project
   * (`/api/p/<id>/…`), it must be the key's own.
   */
  async projectOfKey(req: Request): Promise<FacadeProject> {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw StorageFacadeError.invalidJwt('Missing apikey');
    const ref = req.headers['x-bf-project'];
    if (typeof ref === 'string' && ref && ref !== payload.projectId) {
      throw StorageFacadeError.forbidden('This API key does not belong to the requested project');
    }
    return this.loadProject(payload.projectId);
  }

  anonymous(): FacadeCaller {
    return ANON_CALLER;
  }

  get signer(): StorageSigningService {
    return this.signing;
  }

  // ── Objects ─────────────────────────────────────────────

  async upload(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    key: string,
    input: UploadInput,
    opts: UploadOptions,
  ): Promise<{ Id: string; Key: string }> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    const limits = await this.catalog.getBucketIfAvailable(project.id, bucket);
    this.assertWithinBucketLimits(limits, input.size, input.contentType);

    const existing = await this.storage.statObjectIn(minioBucket, key);
    if (existing && !opts.upsert) throw StorageFacadeError.duplicate();

    const owner = opts.owner ?? ownerTag(who.caller);
    if (this.rls(project)) {
      await this.dryRunInsert(project, who, bucket, key, {
        owner,
        upsert: opts.upsert,
        size: input.size ?? 0,
        mimetype: input.contentType,
        cacheControl: input.cacheControl,
        userMetadata: input.userMetadata,
      });
    } else {
      this.requireWriter(who);
      const mode = await this.access.resolveMode(project.id, bucket, key);
      if (mode === 'owner-only' && !isPrivileged(who.caller)) {
        this.access.assertCanOverwrite(who.caller, mode, existing, key);
      }
    }

    const meta: Record<string, string> = {};
    if (owner) meta['x-amz-meta-owner'] = owner;
    if (input.cacheControl) meta['Cache-Control'] = input.cacheControl;
    if (input.userMetadata) meta[USER_METADATA_HEADER] = JSON.stringify(input.userMetadata).slice(0, 2048);

    const body = Buffer.isBuffer(input.body) ? Readable.from(input.body) : input.body;
    const size = Buffer.isBuffer(input.body) ? input.body.length : input.size ?? 0;
    const uploaded = await this.storage.uploadObjectStream(
      project.id,
      undefined,
      bucket,
      key,
      body,
      size,
      input.contentType || 'application/octet-stream',
      meta,
    );
    return { Id: uploaded.id ?? syntheticObjectId(bucket, key), Key: `${bucket}/${key}` };
  }

  /** SELECT-level authorisation: the catalog row (rls) or null (presets); throws 404/403. */
  async authorizeRead(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    key: string,
    minioBucket: string,
  ): Promise<CatalogObjectRow | null> {
    if (this.rls(project)) {
      const rows = await this.runRls(project, who, (c) => c.query<CatalogObjectRow>(RLS_SELECT_SQL, [bucket, key]));
      if (rows.rows.length === 0) throw StorageFacadeError.notFound();
      return rows.rows[0];
    }
    const mode = await this.access.resolveMode(project.id, bucket, key);
    if (!mode || isPrivileged(who.caller)) return null;
    const stat = mode === 'owner-only' ? await this.storage.statObjectIn(minioBucket, key) : null;
    if (mode === 'owner-only' && !stat) throw StorageFacadeError.notFound();
    this.access.assertCanRead(who.caller, mode, stat, key);
    return null;
  }

  async open(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    key: string,
    rangeHeader?: string,
  ): Promise<ByteSource> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    await this.authorizeRead(project, who, bucket, key, minioBucket);
    return this.openIn(minioBucket, key, rangeHeader);
  }

  /** Bytes from a bucket already judged readable (public bucket, signed URL). */
  async openIn(minioBucket: string, key: string, rangeHeader?: string): Promise<ByteSource> {
    const stat = await this.storage.statObjectIn(minioBucket, key);
    if (!stat) throw StorageFacadeError.notFound();
    const range = parseRange(rangeHeader, stat.size);
    const { stream } = await this.storage.getObjectIn(
      minioBucket,
      key,
      range ? { offset: range.start, length: range.end - range.start + 1 } : undefined,
    );
    return { stream, stat, range };
  }

  async stat(project: FacadeProject, who: FacadeCaller, bucket: string, key: string): Promise<{ stat: StatLike; row: CatalogObjectRow | null }> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    const row = await this.authorizeRead(project, who, bucket, key, minioBucket);
    const stat = await this.storage.statObjectIn(minioBucket, key);
    if (!stat) throw StorageFacadeError.notFound();
    return { stat, row };
  }

  async info(project: FacadeProject, who: FacadeCaller, bucket: string, key: string): Promise<Record<string, unknown>> {
    const { stat, row } = await this.stat(project, who, bucket, key);
    return objectInfo(bucket, key, stat, row);
  }

  async list(project: FacadeProject, who: FacadeCaller, bucket: string, body: Record<string, unknown> | undefined): Promise<FileObject[]> {
    const opts = normaliseListOptions(body);
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    if (this.rls(project)) {
      const q = buildListQuery(bucket, opts);
      const { rows } = await this.runRls(project, who, (c) => c.query<ListRow>(q.text, q.values));
      return rows.map(fileObjectFromRow);
    }
    return this.listWithPresets(project, who, bucket, minioBucket, opts);
  }

  private async listWithPresets(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    minioBucket: string,
    opts: ListOptions,
  ): Promise<FileObject[]> {
    const mode = await this.access.resolveMode(project.id, bucket, opts.prefix);
    if (mode && mode !== 'owner-only') this.access.assertCanRead(who.caller, mode, null, opts.prefix || '/');
    const objects = await this.storage.listObjectsIn(minioBucket, opts.prefix, false);
    const visible = await this.access.filterListing(who.caller, mode, objects, (k) => this.storage.statObjectIn(minioBucket, k));
    const entries: FileObject[] = [];
    const seenFolders = new Set<string>();
    for (const o of visible) {
      if (o.prefix) {
        const name = o.prefix.slice(opts.prefix.length).replace(/\/$/, '');
        if (name && !seenFolders.has(name)) {
          seenFolders.add(name);
          entries.push(folderObject(name));
        }
        continue;
      }
      const display = o.name.slice(opts.prefix.length);
      if (!display) continue;
      entries.push(fileObjectFromStat(bucket, o.name, display, o));
    }
    return applyListOptions(entries, opts);
  }

  async remove(project: FacadeProject, who: FacadeCaller, bucket: string, keys: string[]): Promise<FileObject[]> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    if (keys.length === 0) return [];
    if (this.rls(project)) {
      const { rows } = await this.runRls(project, who, (c) => c.query<ListRow>(RLS_DELETE_SQL, [bucket, keys]));
      await this.storage.removeObjectsIn(minioBucket, rows.map((r) => r.name));
      return rows.map(fileObjectFromRow);
    }
    this.requireWriter(who);
    const statFn = (k: string) => this.storage.statObjectIn(minioBucket, k);
    await this.access.assertCanModifyAll(who.caller, project.id, bucket, keys, statFn, 'delete');
    const removed: FileObject[] = [];
    const present: string[] = [];
    for (const key of keys) {
      const stat = await statFn(key);
      if (!stat) continue;
      present.push(key);
      removed.push(fileObjectFromStat(bucket, key, key, stat));
    }
    if (present.length) await this.storage.deleteObjects(project.id, undefined, bucket, present, { expandFolders: false });
    return removed;
  }

  async move(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    sourceKey: string,
    destinationKey: string,
    destinationBucket: string = bucket,
  ): Promise<{ message: string }> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    const destPhysical =
      destinationBucket === bucket ? minioBucket : (await this.storage.resolveBucket(project.id, undefined, destinationBucket)).minioBucket;
    if (!(destinationBucket === bucket && sourceKey === destinationKey)) {
      if (await this.storage.statObjectIn(destPhysical, destinationKey)) throw StorageFacadeError.duplicate();
    }
    if (this.rls(project)) {
      if (destinationBucket !== bucket) await this.catalog.upsertBucket(project.id, { name: destinationBucket, public: false });
      // The row moves under the caller's policies and the store follows inside
      // the same short transaction: a refused copy rolls the rename back.
      await this.runRls(project, who, async (c) => {
        const { rows } = await c.query(RLS_MOVE_SQL, [bucket, sourceKey, destinationBucket, destinationKey]);
        if (rows.length === 0) throw StorageFacadeError.notFound();
        if (!(await this.storage.statObjectIn(minioBucket, sourceKey))) throw StorageFacadeError.notFound();
        await this.storage.copyObjectIn(minioBucket, sourceKey, destPhysical, destinationKey);
        await this.storage.removeObjectsIn(minioBucket, [sourceKey]);
      });
      return { message: 'Successfully moved' };
    }
    this.requireWriter(who);
    const statFn = (k: string) => this.storage.statObjectIn(minioBucket, k);
    if (!(await statFn(sourceKey))) throw StorageFacadeError.notFound();
    await this.access.assertCanModifyAll(who.caller, project.id, bucket, [sourceKey], statFn, 'move');
    await this.storage.moveObject(project.id, undefined, bucket, sourceKey, destinationKey, destinationBucket);
    return { message: 'Successfully moved' };
  }

  async copy(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    sourceKey: string,
    destinationKey: string,
    destinationBucket: string = bucket,
  ): Promise<{ Key: string }> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    const destPhysical =
      destinationBucket === bucket ? minioBucket : (await this.storage.resolveBucket(project.id, undefined, destinationBucket)).minioBucket;
    const source = await this.storage.statObjectIn(minioBucket, sourceKey);
    if (!source) throw StorageFacadeError.notFound();
    if (await this.storage.statObjectIn(destPhysical, destinationKey)) throw StorageFacadeError.duplicate();
    const owner = ownerTag(who.caller);
    if (this.rls(project)) {
      await this.runRls(
        project,
        who,
        async (c) => {
          const { rows } = await c.query<CatalogObjectRow>(RLS_SELECT_SQL, [bucket, sourceKey]);
          if (rows.length === 0) throw StorageFacadeError.notFound();
          const src = rows[0];
          await c.query(DRY_INSERT_SQL, [
            destinationBucket,
            destinationKey,
            null,
            owner ?? src.owner_id,
            JSON.stringify(src.metadata ?? objectMetadata({ bucket, name: sourceKey, size: source.size, mimetype: '' })),
            src.user_metadata ? JSON.stringify(src.user_metadata) : null,
            src.version,
          ]);
        },
        true,
      );
    } else {
      this.requireWriter(who);
      await this.authorizeRead(project, who, bucket, sourceKey, minioBucket);
    }
    const meta: Record<string, string> = owner ? { 'x-amz-meta-owner': owner } : {};
    await this.storage.copyObject(project.id, undefined, bucket, sourceKey, destinationKey, destinationBucket, meta);
    return { Key: `${destinationBucket}/${destinationKey}` };
  }

  // ── Signed URLs ─────────────────────────────────────────

  async sign(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    key: string,
    expiresIn: number,
    transform?: Record<string, unknown>,
  ): Promise<{ signedURL: string }> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    await this.authorizeRead(project, who, bucket, key, minioBucket);
    if (!(await this.storage.statObjectIn(minioBucket, key))) throw StorageFacadeError.notFound();
    const t = transformClaimFromOptions(transform);
    const token = this.signing.signDownload(project, bucket, key, expiresIn, t);
    const route = t ? 'render/image/sign' : 'object/sign';
    return { signedURL: `/${route}/${bucket}/${key}?token=${token}` };
  }

  async signMany(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    expiresIn: number,
    paths: string[],
  ): Promise<Array<{ error: string | null; path: string; signedURL: string | null }>> {
    const out: Array<{ error: string | null; path: string; signedURL: string | null }> = [];
    for (const path of paths) {
      try {
        const key = String(path ?? '').replace(/^\/+/, '');
        if (!key) throw StorageFacadeError.invalid('Invalid object key');
        const { signedURL } = await this.sign(project, who, bucket, key, expiresIn);
        out.push({ error: null, path, signedURL });
      } catch (err: any) {
        const message = err instanceof StorageFacadeError ? err.body.message : err instanceof HttpException ? err.message : 'Error';
        out.push({ error: message, path, signedURL: null });
      }
    }
    return out;
  }

  async signUpload(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    key: string,
    upsert: boolean,
  ): Promise<{ url: string; token: string }> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket);
    const existing = await this.storage.statObjectIn(minioBucket, key);
    if (existing && !upsert) throw StorageFacadeError.duplicate();
    const owner = ownerTag(who.caller);
    if (this.rls(project)) {
      await this.dryRunInsert(project, who, bucket, key, { owner, upsert, size: 0, mimetype: 'application/octet-stream' });
    } else {
      this.requireWriter(who);
      const mode = await this.access.resolveMode(project.id, bucket, key);
      if (mode === 'owner-only' && !isPrivileged(who.caller)) this.access.assertCanOverwrite(who.caller, mode, existing, key);
    }
    const token = this.signing.signUpload(project, bucket, key, owner, upsert);
    return { url: `/object/upload/sign/${bucket}/${key}?token=${token}`, token };
  }

  // ── Public buckets ──────────────────────────────────────

  /** The physical bucket when it is public; "not found" otherwise, so a private bucket's names leak nothing. */
  async publicBucket(project: FacadeProject, bucket: string): Promise<string> {
    let minioBucket: string;
    try {
      ({ minioBucket } = await this.storage.resolveBucket(project.id, undefined, bucket));
    } catch {
      throw StorageFacadeError.notFound();
    }
    let isPublic: boolean;
    if (this.rls(project)) {
      const row = await this.catalog.getBucketIfAvailable(project.id, bucket);
      isPublic = row ? row.public : await this.storage.bucketIsPublic(minioBucket);
    } else {
      isPublic = await this.storage.bucketIsPublic(minioBucket);
    }
    if (!isPublic) throw StorageFacadeError.notFound();
    return minioBucket;
  }

  async physicalBucket(project: FacadeProject, bucket: string): Promise<string> {
    return (await this.storage.resolveBucket(project.id, undefined, bucket)).minioBucket;
  }

  // ── Buckets ─────────────────────────────────────────────

  async listBuckets(project: FacadeProject, who: FacadeCaller): Promise<SupabaseBucket[]> {
    if (this.rls(project)) {
      const { rows } = await this.runRls(project, who, (c) => c.query<CatalogBucketRow>(`${RLS_BUCKETS_SQL} ORDER BY name`));
      return rows.map((r) => this.bucketFromRow(r));
    }
    this.requireBucketReader(who);
    const names = await this.storage.listBucketNames(project.id);
    const out: SupabaseBucket[] = [];
    for (const b of names) {
      const isPublic = await this.storage.bucketIsPublic(b.physical);
      const row = await this.catalog.getBucketIfAvailable(project.id, b.name);
      out.push({
        id: b.name,
        name: b.name,
        owner: '',
        public: isPublic,
        file_size_limit: row?.file_size_limit ?? null,
        allowed_mime_types: row?.allowed_mime_types ?? null,
        created_at: row?.created_at ? this.iso(row.created_at) : b.createdAt,
        updated_at: row?.updated_at ? this.iso(row.updated_at) : b.createdAt,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getBucket(project: FacadeProject, who: FacadeCaller, name: string): Promise<SupabaseBucket> {
    if (this.rls(project)) {
      const { rows } = await this.runRls(project, who, (c) => c.query<CatalogBucketRow>(`${RLS_BUCKETS_SQL} WHERE id = $1`, [name]));
      if (rows.length === 0) throw StorageFacadeError.bucketNotFound();
      return this.bucketFromRow(rows[0]);
    }
    this.requireBucketReader(who);
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, name);
    const isPublic = await this.storage.bucketIsPublic(minioBucket);
    const row = await this.catalog.getBucketIfAvailable(project.id, name);
    const now = new Date().toISOString();
    return {
      id: name,
      name,
      owner: '',
      public: isPublic,
      file_size_limit: row?.file_size_limit ?? null,
      allowed_mime_types: row?.allowed_mime_types ?? null,
      created_at: row?.created_at ? this.iso(row.created_at) : now,
      updated_at: row?.updated_at ? this.iso(row.updated_at) : now,
    };
  }

  async createBucket(project: FacadeProject, body: Record<string, unknown>): Promise<{ name: string }> {
    const name = String(body.id ?? body.name ?? '').trim();
    if (!name) throw StorageFacadeError.invalid('Bucket id is required');
    await this.storage.createBucket(project.id, undefined, name, body.public === true);
    const limits = this.bucketLimits(body);
    if (limits.fileSizeLimit !== undefined || limits.allowedMimeTypes !== undefined) {
      await this.catalog.updateBucket(project.id, name, { public: body.public === true, ...limits });
    }
    return { name };
  }

  async updateBucket(project: FacadeProject, name: string, body: Record<string, unknown>): Promise<{ message: string }> {
    await this.storage.resolveBucket(project.id, undefined, name);
    if (typeof body.public === 'boolean') {
      await this.storage.toggleBucketPublic(project.id, undefined, name, body.public);
    }
    const limits = this.bucketLimits(body);
    await this.catalog.updateBucket(project.id, name, {
      public: typeof body.public === 'boolean' ? body.public : undefined,
      ...limits,
    });
    return { message: 'Successfully updated' };
  }

  async emptyBucket(project: FacadeProject, name: string): Promise<{ message: string }> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, name);
    const objects = await this.storage.listObjectsIn(minioBucket, '', true);
    await this.storage.removeObjectsIn(minioBucket, objects.map((o) => o.name));
    await this.catalog.emptyBucket(project.id, name);
    return { message: 'Successfully emptied' };
  }

  async deleteBucket(project: FacadeProject, name: string): Promise<{ message: string }> {
    const { minioBucket } = await this.storage.resolveBucket(project.id, undefined, name);
    const objects = await this.storage.listObjectsIn(minioBucket, '', true);
    if (objects.length > 0) {
      throw new StorageFacadeError({
        statusCode: '409',
        error: 'InvalidRequest',
        message: 'The bucket you tried to delete is not empty',
      });
    }
    await this.storage.deleteBucket(project.id, undefined, name);
    return { message: 'Successfully deleted' };
  }

  // ── Responses ───────────────────────────────────────────

  /**
   * Streams an object with the headers a browser and storage-js expect. The
   * cross-origin resource policy is set because helmet's default (same-origin)
   * stops an `<img>` on the customer's site from showing the file.
   */
  pipeBytes(res: Response, source: ByteSource, key: string, download: string | true | undefined): void {
    const { stream, stat, range } = source;
    const fileName = key.split('/').pop() || 'download';
    const type = (stat.metaData?.['content-type'] as string | undefined) || 'application/octet-stream';
    // setHeader, not res.set: Express's set() appends a charset to Content-Type.
    res.setHeader('Content-Type', type);
    const headers: Record<string, string | number> = {
      'Cache-Control': (stat.metaData?.['cache-control'] as string | undefined) || 'no-cache',
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    };
    if (stat.etag) headers.ETag = stat.etag.startsWith('"') ? stat.etag : `"${stat.etag}"`;
    if (stat.lastModified instanceof Date) headers['Last-Modified'] = stat.lastModified.toUTCString();
    headers['Content-Disposition'] =
      download === undefined
        ? contentDisposition('inline', fileName)
        : contentDisposition('attachment', typeof download === 'string' && download ? download : fileName);
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
      res.status(206);
    } else {
      headers['Content-Length'] = stat.size;
    }
    res.set(headers);
    stream.once('error', (err: Error) => {
      this.logger.warn(`Stream of "${key}" failed: ${err.message}`);
      res.destroy();
    });
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  }

  /** Writes only the headers of {@link pipeBytes}: the answer to HEAD. */
  writeHead(res: Response, stat: StatLike, key: string): void {
    const type = (stat.metaData?.['content-type'] as string | undefined) || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    const headers: Record<string, string | number> = {
      'Content-Length': stat.size,
      'Cache-Control': (stat.metaData?.['cache-control'] as string | undefined) || 'no-cache',
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (stat.etag) headers.ETag = stat.etag.startsWith('"') ? stat.etag : `"${stat.etag}"`;
    if (stat.lastModified instanceof Date) headers['Last-Modified'] = stat.lastModified.toUTCString();
    res.status(200).set(headers).end();
  }

  /**
   * Resizes and re-encodes an image on the way out, as the dashboard's render
   * route does: ETag/304, source checks, a concurrency cap and nosniff.
   */
  pipeImage(res: Response, source: ByteSource, key: string, query: Record<string, unknown>, ifNoneMatch: string | undefined): void {
    const { stream, stat } = source;
    if (!this.transforms.available()) {
      stream.destroy();
      throw new StorageFacadeError(
        { statusCode: '501', error: 'NotImplemented', message: 'Image transforms are not available on this build' },
        501,
      );
    }
    let opts;
    try {
      opts = this.transforms.parseTransformQuery(query);
    } catch (err) {
      stream.destroy();
      throw err;
    }
    const cacheControl = `public, max-age=${this.transforms.limits.cacheSeconds}`;
    const etag = this.transforms.etagFor(stat.etag ?? '', opts);
    if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
      stream.destroy();
      res.status(304).set({ ETag: etag, 'Cache-Control': cacheControl }).end();
      return;
    }
    const sourceType = (stat.metaData?.['content-type'] as string | undefined) || 'application/octet-stream';
    const check = this.transforms.isTransformableSource(sourceType, stat.size);
    if (!check.ok) {
      stream.destroy();
      if (check.reason === 'type') throw StorageFacadeError.invalidMimeType(sourceType);
      throw StorageFacadeError.payloadTooLarge('Source image exceeds the transform limit');
    }
    const release = this.transforms.tryAcquire();
    if (!release) {
      stream.destroy();
      res.set('Retry-After', '2');
      throw new StorageFacadeError(
        { statusCode: '503', error: 'ServiceUnavailable', message: 'Too many image transforms in progress, retry shortly' },
        503,
      );
    }
    const { stream: out, contentType, format } = this.transforms.transform(stream, sourceType, opts);
    const baseName = (key.split('/').pop() || 'image').replace(/\.[^.]*$/, '');
    res.setHeader('Content-Type', contentType);
    res.set({
      'Content-Disposition': contentDisposition('inline', `${baseName}.${format === 'jpeg' ? 'jpg' : format}`),
      'Cache-Control': cacheControl,
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.once('close', release);
    out.once('error', (err: Error) => {
      release();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      for (const h of ['Content-Disposition', 'Cache-Control', 'ETag']) res.removeHeader(h);
      res.status(400).type('application/json').send({ statusCode: '422', error: 'InvalidImage', message: `Unprocessable image: ${err.message}` });
    });
    out.pipe(res);
  }

  // ── Internals ───────────────────────────────────────────

  private rls(project: FacadeProject): boolean {
    return project.storageAuthz === 'rls';
  }

  /** In preset mode a bare anon key never writes; a signed-in user or the service key does. */
  private requireWriter(who: FacadeCaller): void {
    if (who.caller.kind === 'anon') {
      throw StorageFacadeError.forbidden(
        "This route requires a signed-in user. Send the end user's access token as a Bearer token alongside the anon key, or call it with the service key from your server.",
      );
    }
  }

  private requireBucketReader(who: FacadeCaller): void {
    this.requireWriter(who);
  }

  private assertWithinBucketLimits(limits: CatalogBucketRow | null, size: number | undefined, contentType: string): void {
    if (!limits) return;
    const cap = limits.file_size_limit === null ? null : Number(limits.file_size_limit);
    if (cap !== null && Number.isFinite(cap) && cap > 0 && size !== undefined && size > cap) {
      throw StorageFacadeError.payloadTooLarge();
    }
    const allowed = limits.allowed_mime_types;
    if (Array.isArray(allowed) && allowed.length > 0) {
      const type = (contentType || '').split(';')[0].trim().toLowerCase();
      const ok = allowed.some((pattern) => {
        const p = String(pattern).trim().toLowerCase();
        if (p === '*/*' || p === type) return true;
        if (p.endsWith('/*')) return type.startsWith(p.slice(0, -1));
        return false;
      });
      if (!ok) throw StorageFacadeError.invalidMimeType(type || contentType);
    }
  }

  private bucketLimits(body: Record<string, unknown>): { fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null } {
    const out: { fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null } = {};
    if ('file_size_limit' in body) {
      const raw = body.file_size_limit;
      if (raw === null || raw === undefined) out.fileSizeLimit = null;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw StorageFacadeError.invalid('file_size_limit must be a non-negative integer');
        out.fileSizeLimit = n;
      }
    }
    if ('allowed_mime_types' in body) {
      const raw = body.allowed_mime_types;
      if (raw === null || raw === undefined) out.allowedMimeTypes = null;
      else if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) out.allowedMimeTypes = raw as string[];
      else throw StorageFacadeError.invalid('allowed_mime_types must be an array of strings');
    }
    return out;
  }

  private bucketFromRow(row: CatalogBucketRow): SupabaseBucket {
    return {
      id: row.id,
      name: row.name,
      owner: row.owner ?? '',
      public: !!row.public,
      file_size_limit: row.file_size_limit === null ? null : Number(row.file_size_limit),
      allowed_mime_types: row.allowed_mime_types ?? null,
      created_at: this.iso(row.created_at),
      updated_at: this.iso(row.updated_at),
    };
  }

  private iso(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return new Date().toISOString();
  }

  /** "Would this INSERT be allowed?" — run under the caller's role and rolled back. */
  private async dryRunInsert(
    project: FacadeProject,
    who: FacadeCaller,
    bucket: string,
    key: string,
    input: { owner?: string; upsert: boolean; size: number; mimetype: string; cacheControl?: string; userMetadata?: Record<string, unknown> },
  ): Promise<void> {
    await this.catalog.upsertBucket(project.id, { name: bucket, public: false }).catch(() => undefined);
    await this.runRls(
      project,
      who,
      (c) =>
        c.query(input.upsert ? DRY_UPSERT_SQL : DRY_INSERT_SQL, [
          bucket,
          key,
          null,
          input.owner ?? null,
          JSON.stringify(
            objectMetadata({ bucket, name: key, size: input.size, mimetype: input.mimetype, cacheControl: input.cacheControl }),
          ),
          input.userMetadata ? JSON.stringify(input.userMetadata) : null,
          null,
        ]),
      true,
    );
  }

  /** Runs under the caller's role; Postgres refusals come back in Supabase's shape. */
  private async runRls<T>(
    project: FacadeProject,
    who: FacadeCaller,
    fn: (client: PoolClient) => Promise<T>,
    dryRun = false,
  ): Promise<T> {
    try {
      return await this.runner.runRlsTransaction(project.id, { role: who.role, jwtClaims: who.jwtClaims }, fn, { dryRun });
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      if (e?.code === '42501' && e.__setRoleFailed) {
        throw new StorageFacadeError(
          {
            statusCode: '500',
            error: 'InternalError',
            message: `Project ${project.id} is not bootstrapped for row-level security; run POST /projects/${project.id}/ensure-rls-bootstrap`,
          },
          500,
        );
      }
      if (e?.code === '42501') throw StorageFacadeError.rlsDenied();
      if (e?.code === '23505') throw StorageFacadeError.duplicate();
      if (e?.code === '42P01' || e?.code === '3F000') {
        throw new StorageFacadeError(
          {
            statusCode: '500',
            error: 'InternalError',
            message: `Project ${project.id} has no storage catalog; run POST /projects/${project.id}/ensure-rls-bootstrap, then POST /projects/${project.id}/storage/catalog/backfill`,
          },
          500,
        );
      }
      const mapped = mapPgError(e);
      if (mapped instanceof ForbiddenException) throw StorageFacadeError.forbidden(mapped.message);
      throw mapped;
    }
  }
}
