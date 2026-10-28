import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { StorageCatalogService } from '../storage/storage-catalog.service';
import { catalogFieldsFromMeta } from '../storage/storage-catalog.sql';

export const STORAGE_AUTHZ_MODES = ['presets', 'rls'] as const;
export type StorageAuthzMode = (typeof STORAGE_AUTHZ_MODES)[number];

export function isStorageAuthzMode(value: unknown): value is StorageAuthzMode {
  return typeof value === 'string' && (STORAGE_AUTHZ_MODES as readonly string[]).includes(value);
}

export interface BackfillResult {
  buckets: number;
  objects: number;
  /** Objects the store listed but could not be read back (left out). */
  skipped: number;
}

/** How many objects are stat'ed at once during a backfill. */
const STAT_BATCH = 16;

/**
 * Rebuilds the storage catalog from what the object store holds, and flips a
 * project between the two authorisation modes.
 *
 * The catalog is kept in step by the write hooks, but a project created
 * before the catalog existed, or whose database was asleep while files were
 * uploaded, has gaps. A full pass over the store fixes them: every bucket and
 * every object is written again (an upsert), nothing is deleted — a row for
 * an object the store no longer has is a listing oddity, not a security hole,
 * since the bytes behind it are gone.
 */
@Injectable()
export class StorageCatalogBackfillService {
  private readonly logger = new Logger(StorageCatalogBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly catalog: StorageCatalogService,
  ) {}

  async status(projectId: string): Promise<{ storageAuthz: StorageAuthzMode; catalogAvailable: boolean }> {
    const project = await this.loadProject(projectId);
    return {
      storageAuthz: project.storageAuthz,
      catalogAvailable: await this.catalog.available(projectId),
    };
  }

  async backfill(projectId: string): Promise<BackfillResult> {
    await this.loadProject(projectId);
    if (!(await this.catalog.available(projectId))) {
      throw new ConflictException(
        'This project has no storage catalog yet. Run POST /projects/:id/ensure-rls-bootstrap first, then backfill.',
      );
    }

    const result: BackfillResult = { buckets: 0, objects: 0, skipped: 0 };
    const buckets = await this.storage.listBucketNames(projectId);
    for (const bucket of buckets) {
      const isPublic = await this.storage.bucketIsPublic(bucket.physical);
      await this.catalog.upsertBucket(projectId, { name: bucket.name, public: isPublic });
      result.buckets++;

      const objects = (await this.storage.listObjectsIn(bucket.physical, '', true)).filter(
        (o) => o.name && !o.name.endsWith('/'),
      );
      for (let i = 0; i < objects.length; i += STAT_BATCH) {
        const batch = objects.slice(i, i + STAT_BATCH);
        await Promise.all(
          batch.map(async (obj) => {
            try {
              const stat = await this.storage.statObjectIn(bucket.physical, obj.name);
              if (!stat) {
                result.skipped++;
                return;
              }
              const fields = catalogFieldsFromMeta(stat.metaData);
              await this.catalog.upsertObject(projectId, {
                bucket: bucket.name,
                name: obj.name,
                size: stat.size,
                mimetype: (stat.metaData?.['content-type'] as string | undefined) || 'application/octet-stream',
                etag: stat.etag,
                cacheControl: fields.cacheControl,
                lastModified: stat.lastModified,
                owner: fields.owner,
                userMetadata: fields.userMetadata,
              });
              result.objects++;
            } catch (err: any) {
              result.skipped++;
              this.logger.warn(
                `Backfill: "${bucket.name}/${obj.name}" of project ${projectId} not catalogued: ${err?.message ?? err}`,
              );
            }
          }),
        );
      }
    }

    this.logger.log(
      `Storage catalog backfilled for project ${projectId}: ${result.buckets} bucket(s), ${result.objects} object(s), ${result.skipped} skipped`,
    );
    return result;
  }

  /**
   * Switches the mode. Going to `rls` requires the catalog to exist and runs a
   * backfill first, so the policies have rows to judge from the first request.
   */
  async setMode(projectId: string, mode: unknown): Promise<{ storageAuthz: StorageAuthzMode; backfill?: BackfillResult }> {
    if (!isStorageAuthzMode(mode)) {
      throw new BadRequestException(`mode must be one of ${STORAGE_AUTHZ_MODES.join(', ')}`);
    }
    const project = await this.loadProject(projectId);
    let backfill: BackfillResult | undefined;
    if (mode === 'rls') backfill = await this.backfill(projectId);
    if (project.storageAuthz !== mode) {
      await this.prisma.project.update({ where: { id: projectId }, data: { storageAuthz: mode } });
      this.logger.log(`Project ${projectId} storage authorisation set to "${mode}"`);
    }
    return { storageAuthz: mode, backfill };
  }

  private async loadProject(projectId: string): Promise<{ id: string; storageAuthz: StorageAuthzMode }> {
    const row = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: { id: true, storageAuthz: true },
    });
    if (!row) throw new NotFoundException('Project not found');
    return { id: row.id, storageAuthz: isStorageAuthzMode(row.storageAuthz) ? row.storageAuthz : 'presets' };
  }
}
