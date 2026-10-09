import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { BucketInventoryEntry, PLATFORM_BUCKETS, StorageService } from '../storage/storage.service';

/**
 * Server disk figures for the root console.
 *
 * Filesystem totals come from statfs() on two paths: the container's own root,
 * which lives on the Docker data volume, and an empty host directory
 * bind-mounted read-only so the system disk can be measured without exposing
 * anything else on it. The breakdown of what fills the data volume is pieced
 * together from sources we already own — pg_database_size, the bucket
 * inventory, the WAL spool, the Docker daemon — and cached, because none of it
 * needs to be fresher than a few minutes and some of it costs a directory walk.
 */

export interface ConsoleFilesystem {
  key: 'data' | 'system';
  label: string;
  /** Where it is mounted on the host, when known. */
  mount: string | null;
  /** False when the probe path is not mounted into the container. */
  available: boolean;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** As df reports it: used / (used + available). */
  usedPercent: number;
  warnPercent: number;
  criticalPercent: number;
  note: string;
}

export interface ConsoleDiskItem {
  key: string;
  label: string;
  /** Null when the source could not be read this time. */
  bytes: number | null;
  hint: string;
  measuredAt: string | null;
}

export interface ConsoleDisk {
  generatedAt: string;
  filesystems: ConsoleFilesystem[];
  breakdown: {
    items: ConsoleDiskItem[];
    accountedBytes: number;
    /** Data-volume usage not covered by any item; null when the volume is not measurable. */
    unaccountedBytes: number | null;
    measuredAt: string | null;
    /** True while the first measurement is still running. */
    pending: boolean;
  };
  docker: {
    rootDir: string | null;
    volumes: number;
    dedicatedDbVolumes: number;
  } | null;
  guard: { warnPercent: number; criticalPercent: number; schedule: string };
}

interface Breakdown {
  items: ConsoleDiskItem[];
  docker: ConsoleDisk['docker'];
  measuredAt: string;
}

interface FsStats {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

const BREAKDOWN_TTL_MS = 5 * 60 * 1000;
/** How long a console request waits for a fresh breakdown before showing the cached one. */
const BREAKDOWN_WAIT_MS = 10_000;
const DOCKER_TIMEOUT_MS = 8_000;
/** Directory walks stop here so a runaway spool cannot pin the API. */
const WALK_FILE_CAP = 250_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const sleep = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/** Buckets that hold our own backups rather than customer or platform files. */
const BACKUP_BUCKETS = new Set(['bf-platform-pitr', 'bf-platform-auto-backups']);
/** Platform-owned buckets carry a `-platform-` infix under either naming generation. */
const PLATFORM_BUCKET_RE = /^(bf|kb)-platform-/;

type BucketGroup = 'project' | 'stale' | 'backups' | 'platform' | 'orphan';

/** Sort the bucket inventory into what the disk panel shows. */
function splitBuckets(
  buckets: BucketInventoryEntry[],
  statusByProject: Map<string, string>,
): Record<BucketGroup, { bytes: number; buckets: number }> {
  const out: Record<BucketGroup, { bytes: number; buckets: number }> = {
    project: { bytes: 0, buckets: 0 },
    stale: { bytes: 0, buckets: 0 },
    backups: { bytes: 0, buckets: 0 },
    platform: { bytes: 0, buckets: 0 },
    orphan: { bytes: 0, buckets: 0 },
  };
  for (const b of buckets) {
    let group: BucketGroup;
    if (BACKUP_BUCKETS.has(b.bucket)) group = 'backups';
    else if (PLATFORM_BUCKETS.includes(b.bucket) || PLATFORM_BUCKET_RE.test(b.bucket)) group = 'platform';
    else {
      const status = b.projectId ? statusByProject.get(b.projectId) : undefined;
      group = !status ? 'orphan' : status === 'DELETED' || status === 'DEACTIVATED' ? 'stale' : 'project';
    }
    out[group].bytes += b.sizeBytes;
    out[group].buckets += 1;
  }
  return out;
}

@Injectable()
export class DiskUsageService {
  private readonly logger = new Logger(DiskUsageService.name);
  private cache: { at: number; value: Breakdown } | null = null;
  private inflight: Promise<Breakdown> | null = null;
  private dockerRootDir: { at: number; value: string | null } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  // ── Filesystems ──────────────────────────────────────────

  async getFilesystems(): Promise<ConsoleFilesystem[]> {
    const warnPercent = this.config.get<number>('disk.warnPercent') ?? 80;
    const criticalPercent = this.config.get<number>('disk.criticalPercent') ?? 90;
    const dataPath = this.config.get<string>('disk.dataPath') || '/';
    const systemPath = this.config.get<string>('disk.systemPath') || '/host/system';

    const [data, system, rootDir] = await Promise.all([
      this.statfs(dataPath),
      this.statfs(systemPath),
      this.getDockerRootDir(),
    ]);

    const empty: FsStats = { totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0 };
    return [
      {
        key: 'data',
        label: 'Data volume',
        mount: rootDir ? path.posix.dirname(rootDir) : null,
        available: !!data,
        ...(data ?? empty),
        warnPercent,
        criticalPercent,
        note: 'Docker data root: databases, file storage, images and logs',
      },
      {
        key: 'system',
        label: 'System disk',
        mount: '/',
        available: !!system,
        ...(system ?? empty),
        warnPercent,
        criticalPercent,
        note: system
          ? 'Operating system, swap and working files'
          : `Not measured: mount a host directory at ${systemPath} (read-only) to enable it`,
      },
    ];
  }

  private async statfs(p: string): Promise<FsStats | null> {
    try {
      const s = await fs.statfs(p);
      const bsize = Number(s.bsize);
      const totalBytes = Number(s.blocks) * bsize;
      const freeBytes = Number(s.bfree) * bsize;
      const availableBytes = Number(s.bavail) * bsize;
      const usedBytes = totalBytes - freeBytes;
      const denominator = usedBytes + availableBytes;
      return {
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent: denominator > 0 ? round1((usedBytes / denominator) * 100) : 0,
      };
    } catch {
      return null;
    }
  }

  // ── Full report ──────────────────────────────────────────

  async getDisk(): Promise<ConsoleDisk> {
    const [filesystems, breakdown] = await Promise.all([this.getFilesystems(), this.getBreakdown()]);
    const data = filesystems.find((f) => f.key === 'data');
    const items = breakdown?.items ?? [];
    const accountedBytes = items.reduce((s, i) => s + (i.bytes ?? 0), 0);
    const unaccountedBytes =
      data?.available && breakdown ? Math.max(0, data.usedBytes - accountedBytes) : null;

    return {
      generatedAt: new Date().toISOString(),
      filesystems,
      breakdown: {
        items,
        accountedBytes,
        unaccountedBytes,
        measuredAt: breakdown?.measuredAt ?? null,
        pending: !breakdown,
      },
      docker: breakdown?.docker ?? null,
      guard: {
        warnPercent: this.config.get<number>('disk.warnPercent') ?? 80,
        criticalPercent: this.config.get<number>('disk.criticalPercent') ?? 90,
        schedule: 'every 6 hours',
      },
    };
  }

  private async getBreakdown(): Promise<Breakdown | null> {
    if (this.cache && Date.now() - this.cache.at < BREAKDOWN_TTL_MS) return this.cache.value;
    if (!this.inflight) {
      this.inflight = this.computeBreakdown()
        .then((value) => {
          this.cache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    // Never hold the console for a slow walk: fall back to the last snapshot.
    const fresh = await Promise.race([this.inflight, sleep(BREAKDOWN_WAIT_MS)]);
    return fresh ?? this.cache?.value ?? null;
  }

  private async computeBreakdown(): Promise<Breakdown> {
    const walArchivePath = this.config.get<string>('disk.walArchivePath') || '/var/lib/postgresql/wal_archive';
    const pitrScratchPath = this.config.get<string>('disk.pitrScratchPath') || '/pitr-scratch';

    const [databases, inventory, projects, walBytes, scratchBytes, docker] = await Promise.all([
      this.databaseSizes(),
      this.storage.getBucketInventory().catch(() => null),
      this.prisma.project.findMany({ select: { id: true, status: true } }).catch(() => []),
      this.directoryBytes(walArchivePath),
      this.directoryBytes(pitrScratchPath),
      this.dockerUsage(),
    ]);

    const now = new Date().toISOString();
    const files = inventory ? splitBuckets(inventory.buckets, new Map(projects.map((p) => [p.id, p.status]))) : null;
    const fileItem = (
      key: string,
      label: string,
      part: { bytes: number; buckets: number } | undefined,
      hint: string,
    ): ConsoleDiskItem => ({
      key,
      label,
      bytes: part ? part.bytes : null,
      hint: part ? `${part.buckets} bucket${part.buckets === 1 ? '' : 's'} · ${hint}` : 'Bucket inventory not measured yet',
      measuredAt: inventory?.measuredAt ?? null,
    });

    const items: ConsoleDiskItem[] = [
      {
        key: 'project_databases',
        label: 'Project databases',
        bytes: databases?.liveProjects ?? null,
        hint: 'Active and paused projects, pg_database_size',
        measuredAt: databases ? now : null,
      },
      {
        key: 'leftover_databases',
        label: 'Leftover project databases',
        bytes: databases?.leftoverProjects ?? null,
        hint: 'Databases of deleted or deactivated projects still on disk',
        measuredAt: databases ? now : null,
      },
      {
        key: 'platform_databases',
        label: 'Platform databases',
        bytes: databases?.platform ?? null,
        hint: databases?.platformNames.length ? databases.platformNames.join(', ') : 'Control plane and auth',
        measuredAt: databases ? now : null,
      },
      fileItem('project_files', 'Project files', files?.project, 'buckets of active and paused projects'),
      fileItem(
        'backups',
        'Backups',
        files?.backups,
        'point-in-time recovery bases and WAL, nightly auto-backups',
      ),
      fileItem(
        'stale_files',
        'Files of deleted projects',
        files?.stale,
        'left behind by deleted or deactivated projects',
      ),
      fileItem('platform_files', 'Platform files', files?.platform, 'feedback attachments, exports, imports, marketing'),
      fileItem(
        'orphan_files',
        'Buckets with no owning project',
        files?.orphan,
        'mostly legacy kb- names from before the rename',
      ),
      {
        key: 'wal_archive',
        label: 'WAL archive spool',
        bytes: walBytes,
        hint: 'Finished WAL segments waiting to be shipped for point-in-time recovery',
        measuredAt: walBytes === null ? null : now,
      },
      {
        key: 'pitr_scratch',
        label: 'Recovery scratch',
        bytes: scratchBytes,
        hint: 'Base backups unpacked for a running or finished point-in-time restore',
        measuredAt: scratchBytes === null ? null : now,
      },
      {
        key: 'docker_images',
        label: 'Docker images',
        bytes: docker?.imageBytes ?? null,
        hint: 'Unique image layers; the guard prunes unused ones',
        measuredAt: docker ? now : null,
      },
      {
        key: 'docker_build_cache',
        label: 'Build cache',
        bytes: docker?.buildCacheBytes ?? null,
        hint: 'Reproducible; pruned by the guard',
        measuredAt: docker ? now : null,
      },
      {
        key: 'docker_containers',
        label: 'Container layers',
        bytes: docker?.containerBytes ?? null,
        hint: 'Writable layers of running containers',
        measuredAt: docker ? now : null,
      },
    ];

    return {
      items,
      measuredAt: now,
      docker: docker
        ? { rootDir: docker.rootDir, volumes: docker.volumes, dedicatedDbVolumes: docker.dedicatedDbVolumes }
        : null,
    };
  }

  // ── Sources ──────────────────────────────────────────────

  /** Every database on the cluster, split into live projects, leftovers and the platform's own. */
  private async databaseSizes(): Promise<{
    liveProjects: number;
    leftoverProjects: number;
    platform: number;
    platformNames: string[];
  } | null> {
    const pool = new Pool({
      host: this.config.get('database.host'),
      port: this.config.get('database.port'),
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: 'postgres',
      max: 1,
    });
    try {
      const [rows, live] = await Promise.all([
        pool.query<{ datname: string; size_bytes: string }>(
          `SELECT datname, pg_database_size(datname)::bigint AS size_bytes
             FROM pg_database
            WHERE NOT datistemplate`,
        ),
        this.prisma.project.findMany({
          where: { status: { in: ['ACTIVE', 'PAUSED'] } },
          select: { dbName: true },
        }),
      ]);
      const liveNames = new Set(live.map((p) => p.dbName));
      const out = { liveProjects: 0, leftoverProjects: 0, platform: 0, platformNames: [] as string[] };
      for (const row of rows.rows) {
        const bytes = Number(row.size_bytes);
        if (liveNames.has(row.datname)) out.liveProjects += bytes;
        else if (row.datname.startsWith('kb_')) out.leftoverProjects += bytes;
        else if (row.datname !== 'postgres') {
          out.platform += bytes;
          out.platformNames.push(row.datname);
        }
      }
      return out;
    } catch (err: any) {
      this.logger.warn(`Could not measure database sizes: ${err.message}`);
      return null;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  /** Bytes under a directory, or null when it is not mounted. Capped so it can never run away. */
  private async directoryBytes(root: string): Promise<number | null> {
    try {
      await fs.access(root);
    } catch {
      return null;
    }
    let total = 0;
    let files = 0;
    const stack = [root];
    while (stack.length > 0 && files < WALK_FILE_CAP) {
      const dir = stack.pop()!;
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          files++;
          try {
            total += (await fs.stat(full)).size;
          } catch {
            // vanished mid-walk — the spool is live
          }
        }
      }
    }
    return total;
  }

  private async getDockerRootDir(): Promise<string | null> {
    if (this.dockerRootDir && Date.now() - this.dockerRootDir.at < 10 * 60 * 1000) {
      return this.dockerRootDir.value;
    }
    const info = await this.dockerGet<{ DockerRootDir?: string }>('/info');
    const value = info?.DockerRootDir ?? null;
    this.dockerRootDir = { at: Date.now(), value };
    return value;
  }

  private async dockerUsage(): Promise<{
    rootDir: string | null;
    imageBytes: number;
    buildCacheBytes: number;
    containerBytes: number;
    volumes: number;
    dedicatedDbVolumes: number;
  } | null> {
    // `type=` keeps the daemon from walking every volume, which takes minutes here.
    const [df, volumes, rootDir] = await Promise.all([
      this.dockerGet<{
        LayersSize?: number;
        Containers?: Array<{ SizeRw?: number }>;
        BuildCache?: Array<{ Size?: number; Shared?: boolean }>;
      }>('/system/df?type=image&type=container&type=build-cache'),
      this.dockerGet<{ Volumes?: Array<{ Name: string }> }>('/volumes'),
      this.getDockerRootDir(),
    ]);
    if (!df) return null;
    const names = volumes?.Volumes?.map((v) => v.Name) ?? [];
    return {
      rootDir,
      imageBytes: df.LayersSize ?? 0,
      buildCacheBytes: (df.BuildCache ?? []).reduce((s, c) => s + (c.Shared ? 0 : c.Size ?? 0), 0),
      containerBytes: (df.Containers ?? []).reduce((s, c) => s + (c.SizeRw ?? 0), 0),
      volumes: names.length,
      dedicatedDbVolumes: names.filter((n) => n.startsWith('bf-pg-')).length,
    };
  }

  /** GET against the Docker daemon over its socket; null on any failure or timeout. */
  private dockerGet<T>(apiPath: string): Promise<T | null> {
    const socketPath = this.config.get<string>('docker.socketPath') || '/var/run/docker.sock';
    return new Promise<T | null>((resolve) => {
      const req = http.request(
        { socketPath, path: apiPath, method: 'GET', timeout: DOCKER_TIMEOUT_MS },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 300) return resolve(null);
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        this.logger.debug(`Docker ${apiPath} unavailable: ${err.message}`);
        resolve(null);
      });
      req.end();
    });
  }
}
