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
import { mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import * as Docker from 'dockerode';
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

/**
 * Shared workspace for restores. platform-api unpacks a base here and the
 * throwaway postgres mounts the same volume, so the path must be identical on
 * both sides — hence a fixed mount point rather than a temp dir.
 */
const SCRATCH_ROOT = '/pitr-scratch';

/** Volume backing {@link SCRATCH_ROOT}, handed to the throwaway container. */
const SCRATCH_VOLUME = process.env.PITR_SCRATCH_VOLUME || 'kolaybase_pitr_scratch';

/**
 * Must match the running cluster: the same major version, and the same
 * extensions — a data directory that loads `vector` cannot start on an image
 * that lacks the library.
 */
const PITR_POSTGRES_IMAGE =
  process.env.PITR_POSTGRES_IMAGE || 'pgvector/pgvector:pg16';

/** Debian postgres images run as this uid; the unpacked data dir must match. */
const POSTGRES_UID = 999;

/** Where the Postgres `archive_command` drops finished WAL segments. */
const WAL_SPOOL_DIR =
  process.env.POSTGRES_WAL_ARCHIVE_DIR || '/var/lib/postgresql/wal_archive';

export interface RecoveryWindow {
  /** Oldest timestamp a restore can target, or null when no base backup exists yet. */
  earliest: string | null;
  /** Newest reachable timestamp — how current the shipped WAL is. */
  latest: string | null;
  /**
   * Oldest instant a true replay can reconstruct exactly. Before this point only
   * whole snapshots exist, so a restore lands on the nearest one instead of the
   * requested moment. Null until the first physical base backup is taken.
   */
  continuousFrom: string | null;
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

    const [bases, wal, clusterBases] = await Promise.all([
      this.storage
        .listPlatformObjects(PITR_BUCKET, `${projectId}/base/`)
        .catch(() => []),
      // WAL is archived per cluster, not per project — the old per-project
      // prefix never matched anything, so this always reported zero segments.
      this.storage.listPlatformObjects(PITR_BUCKET, '_cluster/wal/').catch(() => []),
      this.storage.listPlatformObjects(PITR_BUCKET, CLUSTER_BASE_PREFIX).catch(() => []),
    ]);

    // Exact replay can only reach back to the oldest physical base.
    const continuousFrom = clusterBases.length
      ? new Date(Math.min(...clusterBases.map((b) => b.lastModified.getTime()))).toISOString()
      : null;

    if (bases.length === 0) {
      return {
        earliest: null,
        latest: null,
        continuousFrom,
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
      continuousFrom,
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
    // The empty fallback would otherwise infer as never[], which loses `name`.
    const objects: { name: string; lastModified: Date }[] = await this.storage
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

  /**
   * Take a physical base immediately instead of waiting for the nightly run —
   * used after changing backup configuration, or to shorten the window before a
   * risky migration. Cluster-wide, so ROOT only. Returns as soon as it starts,
   * because a full base takes minutes.
   */
  async runClusterBaseBackupNow(userId: string) {
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (actor?.role !== 'ROOT') {
      throw new ForbiddenException('Only ROOT can trigger a cluster base backup');
    }

    void this.captureClusterBaseBackup()
      .then(() => this.pruneClusterBases())
      .catch((err: any) =>
        this.logger.error(`Manual cluster base backup failed: ${err.message}`),
      );

    return { message: 'Cluster base backup started; it completes in the background.' };
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

  // ── Replay ─────────────────────────────────────────────────────────────────

  /** Newest physical base taken at or before `target`, or null if none exists. */
  private async findClusterBaseBefore(target: Date) {
    const objects: { name: string; lastModified: Date }[] = await this.storage
      .listPlatformObjects(PITR_BUCKET, CLUSTER_BASE_PREFIX)
      .catch(() => []);

    const byStamp = new Map<string, { name: string; lastModified: Date }[]>();
    for (const obj of objects) {
      const stamp = obj.name.slice(CLUSTER_BASE_PREFIX.length).split('/')[0];
      byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), obj]);
    }

    let best: { stamp: string; takenAt: Date; files: { name: string; lastModified: Date }[] } | null =
      null;
    for (const [stamp, files] of byStamp) {
      // The base is only consistent once its last file is written.
      const takenAt = new Date(Math.max(...files.map((f) => f.lastModified.getTime())));
      if (takenAt.getTime() > target.getTime()) continue;
      if (!best || takenAt.getTime() > best.takenAt.getTime()) {
        best = { stamp, takenAt, files };
      }
    }
    return best;
  }

  private async runInContainer(container: Docker.Container, cmd: string[]) {
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    let output = '';
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        // Docker multiplexes stdout/stderr with an 8-byte header per frame.
        output += chunk.length > 8 ? chunk.subarray(8).toString() : chunk.toString();
      });
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    const { ExitCode } = await exec.inspect();
    return { exitCode: ExitCode ?? -1, output: output.trim() };
  }

  /**
   * Rebuild the cluster as it was at `target` in a throwaway postgres, then dump
   * just this project's database out of it.
   *
   * Returns the path to that dump, or null when no physical base predates the
   * target — in which case there is nothing WAL could be replayed onto.
   */
  private async replayIntoDump(dbName: string, target: Date): Promise<string | null> {
    const base = await this.findClusterBaseBefore(target);
    if (!base) return null;

    const runId = randomUUID().slice(0, 8);
    const runDir = join(SCRATCH_ROOT, `restore-${runId}`);
    const dataDir = join(runDir, 'data');
    const walDir = join(runDir, 'wal');
    const dumpPath = join(runDir, 'recovered.dump');
    const fetchScript = join(runDir, 'fetch-wal.sh');
    const containerName = `bf-pitr-${runId}`;
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    let container: Docker.Container | null = null;

    try {
      await mkdir(dataDir, { recursive: true });
      await mkdir(walDir, { recursive: true });

      // 1. Unpack the base. pg_basebackup -Ft writes one tar per tablespace,
      //    plus pg_wal.tar.gz for the segments the base itself needs.
      for (const file of base.files) {
        const leaf = file.name.split('/').pop() as string;
        const localTar = join(runDir, leaf);
        const { stream } = await this.storage.getPlatformObject(PITR_BUCKET, file.name);
        await pipeline(stream, createWriteStream(localTar));

        const target_ = leaf.startsWith('pg_wal') ? join(dataDir, 'pg_wal') : dataDir;
        await mkdir(target_, { recursive: true });
        await execFileAsync('tar', ['-xzf', localTar, '-C', target_]);
        await unlink(localTar).catch(() => undefined);
      }

      // 2. Stage the WAL the replay may need: everything from shortly before the
      //    base through the target.
      const walObjects: { name: string; lastModified: Date }[] = await this.storage
        .listPlatformObjects(PITR_BUCKET, '_cluster/wal/')
        .catch(() => []);
      const from = base.takenAt.getTime() - 60 * 60 * 1000;
      const to = target.getTime() + 60 * 60 * 1000;
      for (const obj of walObjects) {
        const at = obj.lastModified.getTime();
        if (at < from || at > to) continue;
        const leaf = obj.name.split('/').pop() as string;
        const { stream } = await this.storage.getPlatformObject(PITR_BUCKET, obj.name);
        await pipeline(stream, createWriteStream(join(walDir, leaf)));
      }

      // 3. Recovery configuration. archive_mode is forced off so the throwaway
      //    can never write into the live WAL archive after it promotes.
      await writeFile(
        fetchScript,
        [
          '#!/bin/sh',
          'set -e',
          `if [ -f "${walDir}/$1.gz" ]; then exec gunzip -c "${walDir}/$1.gz" > "$2"; fi`,
          `if [ -f "${walDir}/$1" ]; then exec cp "${walDir}/$1" "$2"; fi`,
          'exit 1',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      await writeFile(
        join(dataDir, 'postgresql.auto.conf'),
        [
          '',
          `restore_command = '${fetchScript} %f %p'`,
          `recovery_target_time = '${target.toISOString()}'`,
          "recovery_target_action = 'promote'",
          'archive_mode = off',
          "archive_command = ''",
          '',
        ].join('\n'),
        { flag: 'a' },
      );
      await writeFile(join(dataDir, 'recovery.signal'), '');
      // The throwaway has no network, so trusting local connections is contained
      // and avoids depending on whatever pg_hba the base happened to carry.
      await writeFile(join(dataDir, 'pg_hba.conf'), 'local all all trust\n');
      await execFileAsync('chown', ['-R', `${POSTGRES_UID}:${POSTGRES_UID}`, runDir]);
      await execFileAsync('chmod', ['700', dataDir]);

      // 4. Start it and let recovery replay up to the target.
      container = await docker.createContainer({
        Image: PITR_POSTGRES_IMAGE,
        name: containerName,
        Env: [`PGDATA=${dataDir}`, 'POSTGRES_PASSWORD=unused'],
        User: `${POSTGRES_UID}:${POSTGRES_UID}`,
        HostConfig: {
          Binds: [`${SCRATCH_VOLUME}:${SCRATCH_ROOT}`],
          NetworkMode: 'none',
        },
      } as Docker.ContainerCreateOptions);
      await container.start();

      // Recovery is finished once the server has promoted out of it.
      const owner = process.env.POSTGRES_USER || 'postgres';
      let promoted = false;
      for (let attempt = 0; attempt < 180 && !promoted; attempt++) {
        await new Promise((r) => setTimeout(r, 5000));
        const probe = await this.runInContainer(container, [
          'psql', '-U', owner, '-d', 'postgres', '-tAc', 'select pg_is_in_recovery()',
        ]).catch(() => ({ exitCode: -1, output: '' }));
        promoted = probe.exitCode === 0 && probe.output.includes('f');
      }
      if (!promoted) {
        throw new Error('recovery did not reach the requested time within 15 minutes');
      }

      // 5. Lift this project's database out of the recovered cluster.
      const dumped = await this.runInContainer(container, [
        'pg_dump', '-U', owner, '-d', dbName,
        '--format=custom', '--no-owner', '--no-acl', '-f', dumpPath,
      ]);
      if (dumped.exitCode !== 0) {
        throw new Error(`could not dump the recovered database: ${dumped.output}`);
      }

      return dumpPath;
    } catch (err) {
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    } finally {
      if (container) {
        await container.remove({ force: true }).catch(() => undefined);
      }
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

    // True point-in-time recovery: replay archived WAL onto a physical base so
    // the result is the database as of this instant, not as of a nightly dump.
    const recoveredDump = await this.replayIntoDump(project.dbName, target);
    if (recoveredDump) {
      try {
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
            recoveredDump,
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
      } finally {
        await rm(join(recoveredDump, '..'), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }

      await this.activity.append(projectId, {
        userId,
        kind: ProjectActivityKind.PROJECT_PITR_RESTORED,
        title: 'Database recovered to a point in time',
        detail: `Replayed to ${target.toISOString()}`,
        metadata: { targetTime: target.toISOString(), method: 'wal-replay' },
      });
      this.logger.log(`Project ${projectId} replayed to ${target.toISOString()}`);

      return {
        restoredTo: target.toISOString(),
        exact: true,
        message: 'Database recovered to the requested point in time',
      };
    }

    // No physical base covers that instant, so WAL has nothing to replay onto.
    // Fall back to the nearest daily snapshot and say so plainly rather than
    // implying the exact moment was reached.
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
        restoredTo: base.lastModified.toISOString(),
        exact: false,
        baseBackupTaken: base.lastModified.toISOString(),
        message:
          `No continuous backup covers ${target.toISOString()} yet, so the database was ` +
          `restored to the nearest snapshot, taken ${base.lastModified.toISOString()}. ` +
          `Changes made after that snapshot are not included.`,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
