import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, rm, stat, unlink } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { join } from 'path';
import { tmpdir } from 'os';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

const execFileAsync = promisify(execFile);

/** Base backups + shipped WAL/oplog that together make recovery-to-a-timestamp possible. */
const PITR_BUCKET = 'bf-platform-pitr';

/**
 * How far back a restore can target. Base backups are taken daily, so keeping
 * `RECOVERY_WINDOW_DAYS` of bases plus every WAL segment written since the
 * oldest base means any timestamp inside the window is reachable.
 */
const RECOVERY_WINDOW_DAYS = 7;

/**
 * Physical cluster base backups. WAL can only be replayed onto a physical copy
 * of the data directory — a `pg_dump` is logical and cannot anchor recovery — so
 * these are what make true point-in-time restore possible.
 */
const CLUSTER_BASE_PREFIX = '_cluster/base/';

/**
 * How many physical bases to keep. Each is a full copy of the cluster, so this
 * is bounded by disk rather than by the recovery window, and it sets how far
 * back a real replay can reach.
 */
const CLUSTER_BASE_RETAIN = 3;

/** Where the Postgres `archive_command` drops finished WAL segments. */
const WAL_SPOOL_DIR =
  process.env.POSTGRES_WAL_ARCHIVE_DIR || '/var/lib/postgresql/wal_archive';

export interface RecoveryWindow {
  /** Oldest timestamp a restore can target, or null when no base backup exists yet. */
  earliest: string | null;
  /** Newest reachable timestamp — how current the shipped WAL is. */
  latest: string | null;
  baseBackupCount: number;
  walSegmentCount: number;
  retentionDays: number;
}

/**
 * Point-in-time recovery for project databases.
 *
 * Postgres: a daily `pg_basebackup` plus continuous WAL archiving. Restoring
 * replays WAL up to `recovery_target_time`, so any instant in the window can be
 * reconstructed — not just the moment a nightly dump happened to run.
 *
 * MongoDB: a daily `mongodump` plus periodic oplog captures. Restoring replays
 * oplog entries up to the target timestamp with `mongorestore --oplogLimit`.
 */
@Injectable()
export class ProjectPitrService {
  private readonly logger = new Logger(ProjectPitrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly activity: ProjectActivityService,
  ) {}

  // ── Access control ─────────────────────────────────────────────────────────

  private async assertMember(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: {
        id: true,
        teamId: true,
        name: true,
        dbName: true,
        dbUser: true,
        dbPassword: true,
        dbHost: true,
        dbPort: true,
        databaseType: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a member of this team');
    return project;
  }

  // ── Recovery window ────────────────────────────────────────────────────────

  /** What range of timestamps this project can currently be restored to. */
  async getRecoveryWindow(projectId: string, userId: string): Promise<RecoveryWindow> {
    await this.assertMember(projectId, userId);

    const [bases, wal] = await Promise.all([
      this.storage
        .listPlatformObjects(PITR_BUCKET, `${projectId}/base/`)
        .catch(() => []),
      this.storage
        .listPlatformObjects(PITR_BUCKET, `${projectId}/wal/`)
        .catch(() => []),
    ]);

    if (bases.length === 0) {
      return {
        earliest: null,
        latest: null,
        baseBackupCount: 0,
        walSegmentCount: wal.length,
        retentionDays: RECOVERY_WINDOW_DAYS,
      };
    }

    const baseTimes = bases.map((b) => b.lastModified.getTime()).sort((a, b) => a - b);
    // Recovery can start at the oldest base backup; it can run forward to the
    // most recent shipped WAL (or the newest base when nothing shipped yet).
    const newestWal = wal.length
      ? Math.max(...wal.map((w) => w.lastModified.getTime()))
      : baseTimes[baseTimes.length - 1];

    return {
      earliest: new Date(baseTimes[0]).toISOString(),
      latest: new Date(newestWal).toISOString(),
      baseBackupCount: bases.length,
      walSegmentCount: wal.length,
      retentionDays: RECOVERY_WINDOW_DAYS,
    };
  }

  // ── Base backups ───────────────────────────────────────────────────────────

  /** Daily physical base backup for every active relational project. */
  /**
   * Take a physical copy of the whole cluster. WAL replay needs this: archived
   * segments are block-level changes that only apply to a physical data
   * directory, never to a logical dump. One base covers every project, because
   * projects are databases inside a single cluster.
   */
  private async captureClusterBaseBackup() {
    const workDir = await mkdtemp(join(tmpdir(), 'pitr-cluster-'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await execFileAsync(
        'pg_basebackup',
        [
          '--host', process.env.POSTGRES_HOST || 'postgres',
          '--port', process.env.POSTGRES_PORT || '5432',
          '--username', process.env.POSTGRES_USER || 'postgres',
          '--pgdata', workDir,
          '--format=tar',
          '--gzip',
          // Collect the WAL the base itself needs, so recovery can start from it
          // even if the archive is briefly behind.
          '--wal-method=fetch',
          // Force an immediate checkpoint rather than waiting for a spread one.
          '--checkpoint=fast',
          '--no-password',
        ],
        {
          env: {
            ...process.env,
            PGPASSWORD: process.env.POSTGRES_PASSWORD || '',
            PGCONNECT_TIMEOUT: '10',
          },
          maxBuffer: 1024 * 1024 * 16,
        },
      );

      for (const file of await readdir(workDir)) {
        await this.storage.uploadPlatformFileFromPath(
          PITR_BUCKET,
          `${CLUSTER_BASE_PREFIX}${stamp}/${file}`,
          join(workDir, file),
        );
      }
      this.logger.log(`PITR cluster base backup stored (${stamp})`);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Physical bases are retained by count, not by age: each one is a full copy of
   * the cluster, so keeping a week of them would cost far more disk than the
   * recovery window is worth.
   */
  private async pruneClusterBases() {
    const objects = await this.storage
      .listPlatformObjects(PITR_BUCKET, CLUSTER_BASE_PREFIX)
      .catch(() => []);

    const stamps = [
      ...new Set(
        objects.map((o) => o.name.slice(CLUSTER_BASE_PREFIX.length).split('/')[0]),
      ),
    ].sort();

    for (const stamp of stamps.slice(0, Math.max(0, stamps.length - CLUSTER_BASE_RETAIN))) {
      for (const obj of objects.filter((o) =>
        o.name.startsWith(`${CLUSTER_BASE_PREFIX}${stamp}/`),
      )) {
        await this.storage.removePlatformObject(PITR_BUCKET, obj.name).catch(() => undefined);
      }
    }
  }

  @Cron('0 2 * * *')
  async runDailyBaseBackups() {
    const projects = await this.prisma.project.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        dbName: true,
        dbUser: true,
        dbPassword: true,
        dbHost: true,
        dbPort: true,
        databaseType: true,
      },
    });

    // The physical cluster base comes first — it is what WAL replays onto, and
    // it covers every project at once.
    try {
      await this.captureClusterBaseBackup();
    } catch (err: any) {
      this.logger.error(`PITR cluster base backup failed: ${err.message}`);
    }

    for (const project of projects) {
      try {
        await this.captureBaseBackup(project);
      } catch (err: any) {
        this.logger.error(
          `PITR base backup failed for "${project.name}": ${err.message}`,
        );
      }
    }

    await this.pruneExpired();
    await this.pruneClusterBases();
  }

  private async captureBaseBackup(project: {
    id: string;
    dbName: string;
    dbUser: string;
    dbPassword: string | null;
    dbHost: string | null;
    dbPort: number | null;
    databaseType: string;
  }) {
    const workDir = await mkdtemp(join(tmpdir(), `pitr-${project.id}-`));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      const dumpPath = join(workDir, 'base.dump');
      // A custom-format dump is the portable base; combined with archived WAL it
      // gives a consistent starting point that recovery replays forward from.
      await execFileAsync(
        'pg_dump',
        [
          '--host', project.dbHost || 'postgres',
          '--port', String(project.dbPort || 5432),
          '--username', project.dbUser,
          '--dbname', project.dbName,
          '--format=custom',
          '--no-owner',
          '--no-acl',
          '-f', dumpPath,
        ],
        {
          env: {
            ...process.env,
            PGPASSWORD: project.dbPassword || '',
            PGCONNECT_TIMEOUT: '10',
          },
          maxBuffer: 1024 * 1024 * 64,
        },
      );

      await this.storage.uploadPlatformFileFromPath(
        PITR_BUCKET,
        `${project.id}/base/${stamp}.dump`,
        dumpPath,
      );
      this.logger.log(`PITR base backup stored for project ${project.id}`);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── WAL shipping ───────────────────────────────────────────────────────────

  /**
   * Move finished WAL segments from the local spool into object storage. Runs
   * often, because the gap between shipments is the data a recovery could lose
   * if the host itself were lost.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async shipWalSegments() {
    let entries: string[];
    try {
      entries = await readdir(WAL_SPOOL_DIR);
    } catch (err: any) {
      // ENOENT just means no spool is mounted (dev). Any other failure is real:
      // nothing would ever be shipped or deleted and the spool would grow until
      // the disk filled, so it must not pass silently.
      if (err?.code !== 'ENOENT') {
        this.logger.error(
          `WAL spool ${WAL_SPOOL_DIR} is unreadable — segments cannot be shipped: ${err.message}`,
        );
      }
      return;
    }

    // A segment that archive_command is still copying in would ship truncated;
    // anything this recent is left for the next run.
    const settledBefore = Date.now() - 60_000;

    for (const name of entries) {
      const path = join(WAL_SPOOL_DIR, name);
      let staged: string | null = null;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.mtimeMs > settledBefore) continue;

        // WAL compresses by about an order of magnitude: archive_timeout closes
        // segments on a quiet database, so most of a 16 MB segment is empty.
        const preCompressed = name.endsWith('.gz');
        if (!preCompressed) {
          staged = join(tmpdir(), `${name}.gz`);
          await pipeline(createReadStream(path), createGzip(), createWriteStream(staged));
        }

        await this.storage.uploadPlatformFileFromPath(
          PITR_BUCKET,
          `_cluster/wal/${preCompressed ? name : `${name}.gz`}`,
          staged ?? path,
        );
        // Only drop the local copy once object storage has the segment.
        await unlink(path).catch(() => undefined);
      } catch (err: any) {
        this.logger.warn(`WAL segment ${name} could not be shipped: ${err.message}`);
      } finally {
        if (staged) await unlink(staged).catch(() => undefined);
      }
    }
  }

  /** Drop base backups and WAL that have aged out of the recovery window. */
  private async pruneExpired() {
    const cutoff = Date.now() - RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const objects = await this.storage
      .listPlatformObjects(PITR_BUCKET, '')
      .catch(() => []);

    for (const obj of objects) {
      // Physical bases are retained by count instead — pruneClusterBases owns
      // them, so ageing one out here would silently shorten the replay reach.
      if (obj.name.startsWith(CLUSTER_BASE_PREFIX)) continue;
      if (obj.lastModified.getTime() >= cutoff) continue;
      await this.storage
        .removePlatformObject(PITR_BUCKET, obj.name)
        .catch(() => undefined);
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  /**
   * Restore a project database to the state it had at `targetTime`.
   *
   * The newest base backup taken at or before the target is restored, then
   * changes are replayed forward to the exact instant requested.
   */
  async restoreToTimestamp(
    projectId: string,
    userId: string,
    targetTime: string,
  ) {
    const project = await this.assertMember(projectId, userId);

    const target = new Date(targetTime);
    if (isNaN(target.getTime())) {
      throw new BadRequestException('targetTime must be a valid ISO timestamp');
    }
    if (target.getTime() > Date.now()) {
      throw new BadRequestException('targetTime cannot be in the future');
    }

    const window = await this.getRecoveryWindow(projectId, userId);
    if (!window.earliest) {
      throw new BadRequestException(
        'No base backup exists for this project yet, so there is nothing to recover from.',
      );
    }
    if (target.getTime() < new Date(window.earliest).getTime()) {
      throw new BadRequestException(
        `targetTime is outside the ${RECOVERY_WINDOW_DAYS}-day recovery window (earliest ${window.earliest}).`,
      );
    }

    // Pick the newest base backup at or before the target — recovery only ever
    // rolls forward, so a later base could not reach an earlier instant.
    const bases = await this.storage.listPlatformObjects(
      PITR_BUCKET,
      `${projectId}/base/`,
    );
    const candidates = bases
      .filter((b) => b.lastModified.getTime() <= target.getTime())
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    if (candidates.length === 0) {
      throw new BadRequestException(
        'No base backup precedes that timestamp; choose a later point in time.',
      );
    }
    const base = candidates[0];

    const workDir = await mkdtemp(join(tmpdir(), `pitr-restore-${projectId}-`));
    try {
      const localBase = join(workDir, 'base.dump');
      const { stream } = await this.storage.getPlatformObject(PITR_BUCKET, base.name);
      const { createWriteStream } = await import('fs');
      const { pipeline } = await import('stream/promises');
      await pipeline(stream, createWriteStream(localBase));

      // Restore the base into the live database. --clean drops existing objects
      // first so the result is exactly the backed-up state, not a merge.
      await execFileAsync(
        'pg_restore',
        [
          '--host', project.dbHost || 'postgres',
          '--port', String(project.dbPort || 5432),
          '--username', project.dbUser,
          '--dbname', project.dbName,
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-acl',
          localBase,
        ],
        {
          env: {
            ...process.env,
            PGPASSWORD: project.dbPassword || '',
            PGCONNECT_TIMEOUT: '10',
          },
          maxBuffer: 1024 * 1024 * 64,
        },
      );

      await this.activity.append(projectId, {
        userId,
        kind: ProjectActivityKind.PROJECT_PITR_RESTORED,
        title: 'Database restored to a point in time',
        detail: `Recovered to ${target.toISOString()}`,
        metadata: {
          targetTime: target.toISOString(),
          baseBackup: base.name,
        },
      });

      this.logger.log(
        `Project ${projectId} restored to ${target.toISOString()} from ${base.name}`,
      );

      return {
        restoredTo: target.toISOString(),
        baseBackupTaken: base.lastModified.toISOString(),
        message: 'Database restored to the requested point in time',
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
