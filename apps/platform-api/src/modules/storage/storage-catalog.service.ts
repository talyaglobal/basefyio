import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ProjectRlsRunner } from '../project-db/project-rls-runner';
import {
  CatalogBucketInput,
  CatalogBucketRow,
  CatalogObjectInput,
  CatalogObjectRow,
  DELETE_BUCKET_OBJECTS_SQL,
  DELETE_BUCKET_SQL,
  DELETE_OBJECTS_SQL,
  ENSURE_BUCKET_SQL,
  MOVE_OBJECT_SQL,
  SELECT_BUCKET_SQL,
  SELECT_BUCKETS_SQL,
  SELECT_OBJECT_NAMES_SQL,
  SELECT_OBJECT_SQL,
  UPDATE_BUCKET_SQL,
  UPSERT_BUCKET_SQL,
  UPSERT_OBJECT_SQL,
  catalogFieldsFromMeta,
  isCatalogMissingError,
  isUuid,
  upsertBucketParams,
  upsertObjectParams,
} from './storage-catalog.sql';

/** After the catalog is found missing, how long before the next write tries again. */
const MISSING_RETRY_MS = 5 * 60 * 1000;

/**
 * Keeps `storage.buckets` / `storage.objects` in the project database in
 * step with the object store, as the project owner (outside RLS).
 *
 * Every mutating StorageService method calls in here after the store
 * accepted the change. The calls are best-effort on purpose: a project whose
 * database has not been bootstrapped yet, or is asleep, must still be able
 * to upload — the rows are rebuilt by `backfill` when the project switches to
 * `storageAuthz = 'rls'`, which is the only mode that reads them as the
 * source of truth. Reads (`getBucket`, `getObject`, …) throw when the catalog
 * is missing, so a project in `rls` mode fails loudly instead of answering
 * "not found" for everything.
 */
@Injectable()
export class StorageCatalogService {
  private readonly logger = new Logger(StorageCatalogService.name);
  private readonly missingUntil = new Map<string, number>();

  constructor(private readonly runner: ProjectRlsRunner) {}

  // ── Buckets ─────────────────────────────────────────────

  async upsertBucket(projectId: string, input: CatalogBucketInput): Promise<void> {
    await this.sync(projectId, `bucket ${input.name}`, (c) =>
      c.query(UPSERT_BUCKET_SQL, upsertBucketParams(input)),
    );
  }

  async setBucketPublic(projectId: string, name: string, isPublic: boolean): Promise<void> {
    await this.sync(projectId, `bucket ${name}`, async (c) => {
      await c.query(ENSURE_BUCKET_SQL, [name, isPublic, null, null]);
      await c.query(UPDATE_BUCKET_SQL, [name, isPublic, false, null, false, null]);
    });
  }

  /** Visibility and limits; a field left `undefined` is kept as it is. */
  async updateBucket(
    projectId: string,
    name: string,
    patch: { public?: boolean; fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null },
  ): Promise<void> {
    await this.sync(projectId, `bucket ${name}`, async (c) => {
      await c.query(ENSURE_BUCKET_SQL, [name, patch.public ?? false, null, null]);
      await c.query(UPDATE_BUCKET_SQL, [
        name,
        patch.public ?? null,
        patch.fileSizeLimit !== undefined,
        patch.fileSizeLimit ?? null,
        patch.allowedMimeTypes !== undefined,
        patch.allowedMimeTypes ?? null,
      ]);
    });
  }

  async deleteBucket(projectId: string, name: string): Promise<void> {
    await this.sync(projectId, `bucket ${name}`, async (c) => {
      await c.query(DELETE_BUCKET_OBJECTS_SQL, [name]);
      await c.query(DELETE_BUCKET_SQL, [name]);
    });
  }

  async emptyBucket(projectId: string, name: string): Promise<void> {
    await this.sync(projectId, `bucket ${name}`, (c) => c.query(DELETE_BUCKET_OBJECTS_SQL, [name]));
  }

  // ── Objects ─────────────────────────────────────────────

  /** Records (or refreshes) one object; returns the catalog row id when the catalog took it. */
  async upsertObject(projectId: string, input: CatalogObjectInput): Promise<string | undefined> {
    return this.sync(projectId, `object ${input.bucket}/${input.name}`, async (c) => {
      await c.query(ENSURE_BUCKET_SQL, [
        input.bucket,
        false,
        isUuid(input.owner) ? input.owner : null,
        input.owner ?? null,
      ]);
      const { rows } = await c.query<{ id: string }>(UPSERT_OBJECT_SQL, upsertObjectParams(input));
      return rows[0]?.id;
    });
  }

  /**
   * The upload hook: what the store reported, plus what the upload's headers
   * said about owner, caching and user metadata.
   */
  async recordUpload(
    projectId: string,
    bucket: string,
    name: string,
    stat: { size: number; etag?: string; lastModified?: Date; metaData?: Record<string, unknown> },
    contentType: string,
    meta: Record<string, string> | undefined,
  ): Promise<string | undefined> {
    if (name.endsWith('/')) return undefined; // folder markers are not objects
    const fields = catalogFieldsFromMeta(meta);
    const owner =
      fields.owner ??
      (typeof stat.metaData?.['owner'] === 'string' ? (stat.metaData['owner'] as string) : undefined);
    return this.upsertObject(projectId, {
      bucket,
      name,
      size: stat.size,
      mimetype: (stat.metaData?.['content-type'] as string | undefined) || contentType,
      etag: stat.etag,
      cacheControl: fields.cacheControl,
      lastModified: stat.lastModified,
      owner,
      userMetadata: fields.userMetadata,
    });
  }

  async deleteObjects(projectId: string, bucket: string, names: readonly string[]): Promise<void> {
    const keys = names.filter((n) => n && !n.endsWith('/'));
    if (keys.length === 0) return;
    await this.sync(projectId, `objects in ${bucket}`, (c) => c.query(DELETE_OBJECTS_SQL, [bucket, keys]));
  }

  async moveObject(
    projectId: string,
    bucket: string,
    source: string,
    destination: string,
    destinationBucket: string = bucket,
  ): Promise<void> {
    await this.sync(projectId, `object ${bucket}/${source}`, async (c) => {
      if (destinationBucket !== bucket) await c.query(ENSURE_BUCKET_SQL, [destinationBucket, false, null, null]);
      // A row already at the destination (a stale catalog entry) would block the rename.
      await c.query(DELETE_OBJECTS_SQL, [destinationBucket, [destination]]);
      await c.query(MOVE_OBJECT_SQL, [bucket, source, destinationBucket, destination]);
    });
  }

  // ── Reads (owner role) ──────────────────────────────────

  async getBucket(projectId: string, name: string): Promise<CatalogBucketRow | null> {
    const { rows } = await this.runner.runAsOwner(projectId, (c) =>
      c.query<CatalogBucketRow>(SELECT_BUCKET_SQL, [name]),
    );
    return rows[0] ?? null;
  }

  async listBuckets(projectId: string): Promise<CatalogBucketRow[]> {
    const { rows } = await this.runner.runAsOwner(projectId, (c) => c.query<CatalogBucketRow>(SELECT_BUCKETS_SQL));
    return rows;
  }

  async getObject(projectId: string, bucket: string, name: string): Promise<CatalogObjectRow | null> {
    const { rows } = await this.runner.runAsOwner(projectId, (c) =>
      c.query<CatalogObjectRow>(SELECT_OBJECT_SQL, [bucket, name]),
    );
    return rows[0] ?? null;
  }

  async listObjectNames(projectId: string, bucket: string): Promise<string[]> {
    const { rows } = await this.runner.runAsOwner(projectId, (c) =>
      c.query<{ name: string }>(SELECT_OBJECT_NAMES_SQL, [bucket]),
    );
    return rows.map((r) => r.name);
  }

  /** Like {@link getBucket}, but `null` too when the project has no catalog. */
  async getBucketIfAvailable(projectId: string, name: string): Promise<CatalogBucketRow | null> {
    try {
      return await this.getBucket(projectId, name);
    } catch (err) {
      if (isCatalogMissingError(err)) return null;
      this.logger.debug(`Storage catalog read failed for project ${projectId}: ${(err as Error)?.message}`);
      return null;
    }
  }

  /** Whether `storage.objects` exists in the project database. */
  async available(projectId: string): Promise<boolean> {
    try {
      const { rows } = await this.runner.runAsOwner(projectId, (c) =>
        c.query<{ ok: boolean }>(`SELECT to_regclass('storage.objects') IS NOT NULL AS ok`),
      );
      return !!rows[0]?.ok;
    } catch (err) {
      this.logger.debug(`Storage catalog probe failed for project ${projectId}: ${(err as Error)?.message}`);
      return false;
    }
  }

  // ── Internals ───────────────────────────────────────────

  /**
   * Runs a catalog write as the owner, swallowing what must not break a
   * storage operation: a missing catalog (remembered for a few minutes so a
   * busy project does not probe on every upload), a project that is not
   * active, or a database that cannot be reached right now.
   */
  private async sync<T>(
    projectId: string,
    what: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T | undefined> {
    const until = this.missingUntil.get(projectId);
    if (until && until > Date.now()) return undefined;
    if (until) this.missingUntil.delete(projectId);

    try {
      return await this.runner.runAsOwner(projectId, fn);
    } catch (err: any) {
      if (isCatalogMissingError(err)) {
        this.missingUntil.set(projectId, Date.now() + MISSING_RETRY_MS);
        this.logger.debug(
          `Project ${projectId} has no storage catalog yet; skipping sync of ${what} (run ensure-rls-bootstrap to create it)`,
        );
        return undefined;
      }
      this.logger.warn(`Storage catalog sync of ${what} failed for project ${projectId}: ${err?.message ?? err}`);
      return undefined;
    }
  }
}
