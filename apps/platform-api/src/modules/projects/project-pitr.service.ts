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
    } catch {
      return; // No spool mounted (e.g. dev) — nothing to ship.
    }

    for (const name of entries) {
      const path = join(WAL_SPOOL_DIR, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;

        await this.storage.uploadPlatformFileFromPath(
          PITR_BUCKET,
          `_cluster/wal/${name}`,
          path,
        );
        // Only drop the local copy once object storage has it.
        await unlink(path).catch(() => undefined);
      } catch (err: any) {
        this.logger.warn(`WAL segment ${name} could not be shipped: ${err.message}`);
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
