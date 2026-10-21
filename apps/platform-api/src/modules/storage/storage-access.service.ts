import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { StoragePolicy } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageCaller, isPrivileged, ownerOf } from './storage-caller';

/**
 * Access rules a project can place on a bucket or on a key prefix inside it.
 *
 *  - `public-read`         any valid key may read (what every bucket does with no rule);
 *                          exists so a prefix inside a stricter bucket can be pinned open.
 *  - `authenticated-read`  reads need a signed-in end user; the public key alone is refused.
 *  - `owner-only`          reads, deletes and overwrites are limited to the user who
 *                          uploaded the object (recorded as x-amz-meta-owner).
 *
 * The service key and dashboard team members are never restricted. A bucket
 * with no rule behaves exactly as it always has.
 */
export const STORAGE_POLICY_MODES = ['public-read', 'authenticated-read', 'owner-only'] as const;
export type StoragePolicyMode = (typeof STORAGE_POLICY_MODES)[number];

export type AccessDecision = 'allow' | 'deny-anon' | 'deny-owner';
export type AccessVerb = 'read' | 'delete' | 'overwrite' | 'move';

/** How long one instance trusts its copy of a project's rules. */
const CACHE_TTL_MS = 30_000;
/** `statObject` fan-out width when a listing has to be filtered by owner. */
const STAT_BATCH = 25;

export interface ObjectStat {
  metaData?: Record<string, unknown>;
}

/** Pure decision: what this caller may do under this rule to an object with this owner. */
export function decide(
  caller: StorageCaller,
  mode: StoragePolicyMode | null,
  ownerSub?: string,
): AccessDecision {
  if (!mode || mode === 'public-read') return 'allow';
  if (isPrivileged(caller)) return 'allow';
  if (mode === 'authenticated-read') {
    return caller.kind === 'authenticated' ? 'allow' : 'deny-anon';
  }
  // owner-only
  if (caller.kind !== 'authenticated') return 'deny-anon';
  return ownerSub !== undefined && ownerSub === caller.sub ? 'allow' : 'deny-owner';
}

/** Strips a leading slash and refuses path traversal. '' means the whole bucket. */
export function normalisePrefix(raw: unknown): string {
  const value = String(raw ?? '').trim().replace(/^\/+/, '');
  if (value.includes('..') || value.includes('\0')) {
    throw new BadRequestException('Invalid path prefix');
  }
  return value;
}

export function isPolicyMode(value: unknown): value is StoragePolicyMode {
  return typeof value === 'string' && (STORAGE_POLICY_MODES as readonly string[]).includes(value);
}

/** Longest matching prefix wins; '' matches everything. Unknown modes count as no rule. */
export function resolveModeFromRows(
  rows: readonly Pick<StoragePolicy, 'bucket' | 'pathPrefix' | 'mode'>[],
  bucket: string,
  key: string,
): StoragePolicyMode | null {
  const cleanKey = (key || '').replace(/^\/+/, '');
  let best: Pick<StoragePolicy, 'pathPrefix' | 'mode'> | null = null;
  for (const row of rows) {
    if (row.bucket !== bucket) continue;
    if (row.pathPrefix && !cleanKey.startsWith(row.pathPrefix)) continue;
    if (!best || row.pathPrefix.length > best.pathPrefix.length) best = row;
  }
  if (!best) return null;
  return isPolicyMode(best.mode) ? best.mode : null;
}

@Injectable()
export class StorageAccessService {
  private readonly logger = new Logger(StorageAccessService.name);
  private readonly cache = new Map<string, { at: number; rows: StoragePolicy[] }>();

  constructor(private readonly prisma: PrismaService) {}

  // ── Rules ───────────────────────────────────────────────

  listPolicies(projectId: string): Promise<StoragePolicy[]> {
    return this.prisma.storagePolicy.findMany({
      where: { projectId },
      orderBy: [{ bucket: 'asc' }, { pathPrefix: 'asc' }],
    });
  }

  async setPolicy(
    projectId: string,
    bucket: string,
    input: { mode: unknown; pathPrefix?: unknown },
    createdBy?: string,
  ): Promise<StoragePolicy> {
    if (!isPolicyMode(input?.mode)) {
      throw new BadRequestException(`mode must be one of ${STORAGE_POLICY_MODES.join(', ')}`);
    }
    const pathPrefix = normalisePrefix(input.pathPrefix);
    const row = await this.prisma.storagePolicy.upsert({
      where: { projectId_bucket_pathPrefix: { projectId, bucket, pathPrefix } },
      create: { projectId, bucket, pathPrefix, mode: input.mode, createdBy: createdBy ?? null },
      update: { mode: input.mode, createdBy: createdBy ?? null },
    });
    this.invalidate(projectId);
    return row;
  }

  async removePolicy(projectId: string, bucket: string, pathPrefix: unknown = ''): Promise<number> {
    const clean = normalisePrefix(pathPrefix);
    const result = await this.prisma.storagePolicy.deleteMany({
      where: { projectId, bucket, pathPrefix: clean },
    });
    this.invalidate(projectId);
    return result.count;
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  /** A project's rules, cached per instance for CACHE_TTL_MS. */
  async policiesFor(projectId: string): Promise<StoragePolicy[]> {
    const hit = this.cache.get(projectId);
    const now = Date.now();
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.rows;
    const rows = await this.prisma.storagePolicy.findMany({ where: { projectId } });
    this.cache.set(projectId, { at: now, rows });
    return rows;
  }

  /** The rule that applies to one key, or null when the bucket has none. */
  async resolveMode(projectId: string, bucket: string, key: string): Promise<StoragePolicyMode | null> {
    const rows = await this.policiesFor(projectId);
    if (rows.length === 0) return null;
    return resolveModeFromRows(rows, bucket, key);
  }

  // ── Checks ──────────────────────────────────────────────

  private refuse(decision: Exclude<AccessDecision, 'allow'>, verb: AccessVerb, key: string): never {
    if (decision === 'deny-anon') {
      throw new ForbiddenException(
        `This location requires a signed-in user to ${verb} "${key}". Send the user's access token as a Bearer token alongside the anon key.`,
      );
    }
    throw new ForbiddenException(`Only the owner of "${key}" can ${verb} it.`);
  }

  assertCanRead(caller: StorageCaller, mode: StoragePolicyMode | null, stat: ObjectStat | null, key: string): void {
    const decision = decide(caller, mode, ownerOf(stat));
    if (decision !== 'allow') this.refuse(decision, 'read', key);
  }

  assertCanDelete(caller: StorageCaller, mode: StoragePolicyMode | null, stat: ObjectStat | null, key: string): void {
    const decision = decide(caller, mode, ownerOf(stat));
    if (decision !== 'allow') this.refuse(decision, 'delete', key);
  }

  /** Writing over an existing object counts as touching that object; a new key is free. */
  assertCanOverwrite(
    caller: StorageCaller,
    mode: StoragePolicyMode | null,
    existing: ObjectStat | null,
    key: string,
  ): void {
    if (mode !== 'owner-only' || !existing) return;
    const decision = decide(caller, mode, ownerOf(existing));
    if (decision !== 'allow') this.refuse(decision, 'overwrite', key);
  }

  /**
   * Batch check for delete/move: every key under an owner-only rule must be
   * the caller's own. A whole folder cannot be checked cheaply, so folders are
   * refused for restricted callers in owner-only locations.
   */
  async assertCanModifyAll(
    caller: StorageCaller,
    projectId: string,
    bucket: string,
    keys: readonly string[],
    statFn: (key: string) => Promise<ObjectStat | null>,
    verb: 'delete' | 'move',
  ): Promise<void> {
    if (isPrivileged(caller)) return;
    const rows = await this.policiesFor(projectId);
    if (!rows.some((r) => r.bucket === bucket)) return;
    for (const raw of keys) {
      const key = (raw || '').replace(/^\/+/, '');
      if (!key) continue;
      const mode = resolveModeFromRows(rows, bucket, key);
      if (mode !== 'owner-only') continue;
      if (key.endsWith('/')) {
        throw new ForbiddenException(
          `"${key}" is a folder in an owner-only location; ${verb} its files individually.`,
        );
      }
      const stat = await statFn(key);
      if (!stat) continue; // nothing there; the store call is a no-op for it
      this.assertCanDelete(caller, mode, stat, key);
      if (verb === 'move') {
        const decision = decide(caller, mode, ownerOf(stat));
        if (decision !== 'allow') this.refuse(decision, 'move', key);
      }
    }
  }

  /**
   * Narrows a listing to what the caller may see. Only `owner-only` needs it;
   * folder markers (prefixes) are kept so navigation still works.
   */
  async filterListing<T extends { name: string; prefix?: string }>(
    caller: StorageCaller,
    mode: StoragePolicyMode | null,
    objects: T[],
    statFn: (key: string) => Promise<ObjectStat | null>,
  ): Promise<T[]> {
    if (mode !== 'owner-only' || isPrivileged(caller)) return objects;
    if (caller.kind !== 'authenticated') return objects.filter((o) => !!o.prefix);

    const sub = caller.sub;
    const out: T[] = [];
    const files = objects.filter((o) => !o.prefix && o.name);
    const keep = new Set<string>();
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const batch = files.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(
        batch.map(async (o) => {
          try {
            return await statFn(o.name);
          } catch (err: any) {
            this.logger.debug(`stat failed while filtering listing for ${o.name}: ${err?.message ?? err}`);
            return null;
          }
        }),
      );
      batch.forEach((o, idx) => {
        if (ownerOf(stats[idx]) === sub) keep.add(o.name);
      });
    }
    for (const o of objects) {
      if (o.prefix || keep.has(o.name)) out.push(o);
    }
    return out;
  }
}
