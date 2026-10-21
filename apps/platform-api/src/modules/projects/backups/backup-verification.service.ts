import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { Client, Pool } from 'pg';
import * as yauzl from 'yauzl';
import type { BackupVerificationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { ProjectActivityKind, ProjectActivityService } from '../project-activity.service';
import { ENCRYPTED_SUFFIX, createDecryptStream, getBackupKey } from './backup-crypto';
import { envFlag, envInt, envList } from './backup-env';
import {
  TABLE_COUNTS_ENTRY,
  TableCountsFile,
  collectTableCounts,
  compareTableCounts,
  quoteIdent,
} from './table-counts';

const execFileAsync = promisify(execFile);

const AUTO_BACKUP_BUCKET = 'bf-platform-auto-backups';
const DUMP_ENTRY = 'database/dump.sql';
/** Throwaway databases are named `bfverify_<unix seconds>_<hex>` so a leftover can be aged. */
const VERIFY_DB_PREFIX = 'bfverify_';
const STALE_VERIFY_DB_MS = 6 * 60 * 60 * 1000;
/** A backup older than this is not "the nightly backup" any more; the project is skipped in rotation. */
const ROTATION_MAX_BACKUP_AGE_MS = 48 * 60 * 60 * 1000;
/**
 * A plain-SQL dump inflates several times over its zip, and the restored
 * database takes about as much again; keep that much headroom.
 */
const TEMP_SPACE_FACTOR = 12;
/**
 * Largest archive the drill restores by default. The drill runs on the
 * production cluster, so it sticks to archives that restore in minutes;
 * BACKUP_VERIFY_MAX_ARCHIVE_MB raises it where the host has room.
 */
const DEFAULT_MAX_ARCHIVE_MB = 256;
/**
 * The temp files and the throwaway database land on the same volume as every
 * project's data. The drill never lets that volume's projected usage cross this
 * percentage (BACKUP_VERIFY_MAX_DISK_PERCENT), so verifying a backup can never
 * be what fills the disk.
 */
const DEFAULT_MAX_DISK_PERCENT = 85;

export interface VerificationOptions {
  trigger: 'scheduled' | 'manual';
  requestedBy?: string | null;
  /** Reuse a RUNNING row created by the caller (manual trigger) instead of inserting one. */
  verificationId?: string;
}

export interface VerificationSummary {
  id: string;
  projectId: string;
  trigger: string;
  status: BackupVerificationStatus;
  backupObjectKey: string | null;
  backupTakenAt: string | null;
  archiveBytes: number | null;
  tablesExpected: number | null;
  tablesRestored: number | null;
  rowsMismatched: number | null;
  psqlErrorCount: number | null;
  countsCompared: boolean;
  details: unknown;
  error: string | null;
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

/**
 * Proves a nightly backup can be restored.
 *
 * The newest auto-backup of a project is rebuilt into a throwaway database on
 * the same cluster with the same `psql` path the dashboard restore uses, its
 * tables are counted, and the counts are compared with the ones recorded at
 * dump time (database/tables.json). The database is dropped afterwards, always.
 *
 * Weekly on Sunday 05:00 UTC, one project per run, rotating through those that
 * have a fresh backup — or on demand from the project's Backup page.
 */
@Injectable()
export class BackupVerificationService {
  private readonly logger = new Logger(BackupVerificationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly activity: ProjectActivityService,
  ) {}

  get enabled(): boolean {
    return envFlag('BACKUP_VERIFY_ENABLED', true);
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  @Cron('0 5 * * 0')
  async runScheduledVerification(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Backup restore verification is disabled (BACKUP_VERIFY_ENABLED=false)');
      return;
    }
    const ids = await this.pickProjects(envInt('BACKUP_VERIFY_PROJECTS_PER_RUN', 1));
    if (ids.length === 0) {
      this.logger.warn('Backup restore verification: no project has a recent auto-backup within the size cap');
      return;
    }
    for (const id of ids) {
      try {
        await this.verifyLatestBackup(id, { trigger: 'scheduled' });
      } catch (err: any) {
        this.logger.error(`Scheduled restore verification failed for ${id}: ${err?.message}`);
      }
    }
  }

  /**
   * Which projects to drill this week. BACKUP_VERIFY_PROJECT_IDS wins when set;
   * otherwise the eligible project that has gone longest without a verdict.
   */
  async pickProjects(limit: number): Promise<string[]> {
    const explicit = envList('BACKUP_VERIFY_PROJECT_IDS');
    if (explicit.length > 0) return explicit;

    const candidates = await this.prisma.project.findMany({
      where: { status: 'ACTIVE', databaseType: 'RELATIONAL' },
      select: { id: true },
    });
    if (candidates.length === 0) return [];

    const newest = await this.newestAutoBackups();
    const maxBytes = envInt('BACKUP_VERIFY_MAX_ARCHIVE_MB', DEFAULT_MAX_ARCHIVE_MB) * 1024 * 1024;
    const freshAfter = Date.now() - ROTATION_MAX_BACKUP_AGE_MS;
    const eligible = candidates.filter((c) => {
      const b = newest.get(c.id);
      return !!b && b.lastModified.getTime() >= freshAfter && b.size <= maxBytes;
    });
    if (eligible.length === 0) return [];

    const last = await this.prisma.backupVerification.groupBy({
      by: ['projectId'],
      where: { status: { in: ['PASSED', 'FAILED'] } },
      _max: { startedAt: true },
    });
    const lastAt = new Map(last.map((l) => [l.projectId, l._max.startedAt?.getTime() ?? 0]));
    // Longest without a verdict first; among equals, the smallest archive, so a
    // run finishes quickly and touches the least disk.
    eligible.sort(
      (a, b) =>
        (lastAt.get(a.id) ?? 0) - (lastAt.get(b.id) ?? 0) ||
        (newest.get(a.id)?.size ?? 0) - (newest.get(b.id)?.size ?? 0),
    );
    return eligible.slice(0, Math.max(1, limit)).map((c) => c.id);
  }

  // ── Dashboard entry points ─────────────────────────────────────────────────

  async startManual(projectId: string, userId: string): Promise<{ verificationId: string }> {
    await this.assertMember(projectId, userId);
    if (this.running) {
      throw new ConflictException('A restore verification is already running; try again in a few minutes.');
    }
    const row = await this.prisma.backupVerification.create({
      data: { projectId, trigger: 'manual', requestedBy: userId, status: 'RUNNING' },
    });
    void this.verifyLatestBackup(projectId, {
      trigger: 'manual',
      requestedBy: userId,
      verificationId: row.id,
    }).catch(async (err: any) => {
      if (err instanceof ConflictException) {
        await this.prisma.backupVerification
          .update({
            where: { id: row.id },
            data: { status: 'SKIPPED', error: 'Another verification was running', finishedAt: new Date() },
          })
          .catch(() => undefined);
        return;
      }
      this.logger.error(`Manual restore verification failed for ${projectId}: ${err?.message}`);
    });
    return { verificationId: row.id };
  }

  async listForProject(projectId: string, userId: string, limit = 10): Promise<VerificationSummary[]> {
    await this.assertMember(projectId, userId);
    const rows = await this.prisma.backupVerification.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(50, Math.max(1, limit)),
    });
    return rows.map((r) => this.toSummary(r));
  }

  // ── The drill ──────────────────────────────────────────────────────────────

  /** Restore the newest auto-backup of `projectId` into a throwaway database and record the verdict. */
  async verifyLatestBackup(projectId: string, opts: VerificationOptions): Promise<VerificationSummary> {
    if (this.running) {
      throw new ConflictException('A restore verification is already running');
    }
    this.running = true;
    try {
      return await this.execute(projectId, opts);
    } finally {
      this.running = false;
    }
  }

  private async execute(projectId: string, opts: VerificationOptions): Promise<VerificationSummary> {
    const startedAt = Date.now();
    const row = opts.verificationId
      ? await this.prisma.backupVerification.findUniqueOrThrow({ where: { id: opts.verificationId } })
      : await this.prisma.backupVerification.create({
          data: { projectId, trigger: opts.trigger, requestedBy: opts.requestedBy ?? null, status: 'RUNNING' },
        });
    const update = (data: Prisma.BackupVerificationUpdateInput) =>
      this.prisma.backupVerification.update({ where: { id: row.id }, data });

    const timeoutMs = envInt('BACKUP_VERIFY_TIMEOUT_MS', 30 * 60 * 1000);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    let pool: Pool | null = null;
    let verifyDb: string | null = null;
    let tmp: string | null = null;
    let outcome: { status: BackupVerificationStatus; data: Prisma.BackupVerificationUpdateInput; summary: string };

    try {
      pool = this.adminPool();
      await this.sweepStaleVerifyDatabases(pool);

      const project = await this.prisma.project.findFirst({
        where: { id: projectId, status: { not: 'DELETED' } },
        select: { id: true, name: true, databaseType: true },
      });
      if (!project) {
        outcome = this.skipped('project not found or deleted');
      } else if (project.databaseType !== 'RELATIONAL') {
        outcome = this.skipped('only PostgreSQL projects have a database dump to restore');
      } else {
        const backup = (await this.newestAutoBackups(projectId)).get(projectId) ?? null;
        if (!backup) {
          outcome = this.skipped('no auto-backup exists for this project yet');
        } else {
          await update({
            backupBucket: AUTO_BACKUP_BUCKET,
            backupObjectKey: backup.name,
            backupTakenAt: backup.lastModified,
            archiveBytes: BigInt(backup.size),
          });
          const maxMb = envInt('BACKUP_VERIFY_MAX_ARCHIVE_MB', DEFAULT_MAX_ARCHIVE_MB);
          if (backup.size > maxMb * 1024 * 1024) {
            outcome = this.skipped(
              `archive is ${Math.round(backup.size / 1024 / 1024)} MB, above BACKUP_VERIFY_MAX_ARCHIVE_MB=${maxMb}`,
            );
          } else {
            tmp = await mkdtemp(join(tmpdir(), 'bf-verify-'));
            const roomProblem = describeDiskShortage(
              await this.diskUsage(tmp),
              backup.size * TEMP_SPACE_FACTOR,
              envInt('BACKUP_VERIFY_MAX_DISK_PERCENT', DEFAULT_MAX_DISK_PERCENT),
            );
            if (roomProblem) {
              outcome = this.skipped(roomProblem);
            } else {
              outcome = await this.restoreAndCompare(pool, backup.name, tmp, abort.signal, (db) => {
                verifyDb = db;
                return update({ verifyDbName: db });
              });
            }
          }
        }
      }
    } catch (err: any) {
      const timedOut = abort.signal.aborted;
      const message = timedOut
        ? `timed out after ${timeoutMs} ms`
        : String(err?.message || err).slice(0, 1000);
      outcome = {
        status: 'FAILED',
        data: { error: message },
        summary: message,
      };
    } finally {
      clearTimeout(timer);
      if (verifyDb && pool) {
        await pool
          .query(`DROP DATABASE IF EXISTS ${quoteIdent(verifyDb)} WITH (FORCE)`)
          .catch((err: any) =>
            this.logger.error(`Verification database ${verifyDb} could not be dropped: ${err?.message}`),
          );
      }
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      if (pool) await pool.end().catch(() => undefined);
    }

    const finished = await update({
      ...outcome.data,
      status: outcome.status,
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt,
    });

    await this.report(projectId, outcome.status, outcome.summary, opts, finished.id);
    return this.toSummary(finished);
  }

  private skipped(reason: string) {
    return { status: 'SKIPPED' as BackupVerificationStatus, data: { error: reason }, summary: reason };
  }

  /** Download, extract, create the throwaway database, replay, count, compare. */
  private async restoreAndCompare(
    pool: Pool,
    objectKey: string,
    tmp: string,
    signal: AbortSignal,
    onDatabaseCreated: (name: string) => Promise<unknown>,
  ): Promise<{ status: BackupVerificationStatus; data: Prisma.BackupVerificationUpdateInput; summary: string }> {
    const zipPath = join(tmp, 'archive.zip');
    await this.download(objectKey, zipPath);

    const entries = await extractZipEntries(zipPath, new Set([DUMP_ENTRY, TABLE_COUNTS_ENTRY]), tmp);
    const dumpPath = entries.get(DUMP_ENTRY);
    if (!dumpPath) {
      return { status: 'FAILED', data: { error: `archive has no ${DUMP_ENTRY}` }, summary: `archive has no ${DUMP_ENTRY}` };
    }

    let expected: TableCountsFile | null = null;
    const countsPath = entries.get(TABLE_COUNTS_ENTRY);
    if (countsPath) {
      try {
        const parsed = JSON.parse(await readFile(countsPath, 'utf8')) as TableCountsFile;
        if (parsed && Array.isArray(parsed.tables)) expected = parsed;
      } catch {
        expected = null;
      }
    }

    const verifyDb = `${VERIFY_DB_PREFIX}${Math.floor(Date.now() / 1000)}_${randomBytes(3).toString('hex')}`;
    await pool.query(`CREATE DATABASE ${quoteIdent(verifyDb)} TEMPLATE template0 ENCODING 'UTF8'`);
    await onDatabaseCreated(verifyDb);

    const psql = await this.runPsql(verifyDb, dumpPath, signal);
    const actual = await this.countRestored(verifyDb);
    const comparison = expected ? compareTableCounts(expected.tables, actual.tables) : null;

    const tablesRestored = actual.tables.length;
    const tablesExpected = expected ? expected.tables.length : null;
    const rowsMismatched = comparison ? comparison.mismatches.length : null;
    const missing = comparison ? comparison.missingTables.length : 0;

    const passed =
      psql.errorCount === 0 &&
      (comparison ? missing === 0 && comparison.mismatches.length === 0 : tablesRestored > 0);

    // Plain JSON by construction; the cast is only because Prisma's JSON type
    // does not accept interface-typed arrays.
    const details = {
      missingTables: comparison?.missingTables ?? [],
      mismatches: (comparison?.mismatches ?? []).slice(0, 50),
      compared: comparison?.compared ?? 0,
      psqlErrors: psql.errors.slice(0, 20),
      expectedTruncated: expected?.truncated ?? false,
      snapshot: expected?.snapshot ?? null,
    } as unknown as Prisma.InputJsonValue;

    const parts: string[] = [`${tablesRestored} table(s) restored`];
    if (comparison) {
      parts.push(`${comparison.compared} count(s) compared`);
      if (missing) parts.push(`${missing} missing`);
      if (comparison.mismatches.length) parts.push(`${comparison.mismatches.length} row-count mismatch(es)`);
    } else {
      parts.push('no dump-time counts in this archive');
    }
    if (psql.errorCount) parts.push(`${psql.errorCount} psql error(s)`);

    return {
      status: passed ? 'PASSED' : 'FAILED',
      data: {
        tablesExpected,
        tablesRestored,
        rowsMismatched,
        psqlErrorCount: psql.errorCount,
        countsCompared: !!comparison,
        details,
        error: passed ? null : parts.join(', '),
      },
      summary: parts.join(', '),
    };
  }

  private async download(objectKey: string, zipPath: string): Promise<void> {
    const { stream } = await this.storage.getPlatformObject(AUTO_BACKUP_BUCKET, objectKey);
    if (objectKey.endsWith(ENCRYPTED_SUFFIX)) {
      const key = getBackupKey();
      if (!key) throw new Error('this backup is encrypted but BACKUP_ENC_KEY is not set');
      await pipeline(stream, createDecryptStream(key), createWriteStream(zipPath));
      return;
    }
    await pipeline(stream, createWriteStream(zipPath));
  }

  private async runPsql(
    verifyDb: string,
    dumpPath: string,
    signal: AbortSignal,
  ): Promise<{ errorCount: number; errors: string[] }> {
    const admin = this.adminConnection();
    let stderr = '';
    try {
      const res = await execFileAsync(
        'psql',
        [
          '--host', admin.host,
          '--port', String(admin.port),
          '--username', admin.user,
          '--dbname', verifyDb,
          '--no-password',
          '--quiet',
          '-v', 'ON_ERROR_STOP=0',
          '--file', dumpPath,
        ],
        {
          env: {
            ...process.env,
            PGPASSWORD: admin.password,
            PGCONNECT_TIMEOUT: '10',
            PGOPTIONS: '-c client_min_messages=warning',
          },
          maxBuffer: 16 * 1024 * 1024,
          signal,
        },
      );
      stderr = res.stderr ?? '';
    } catch (err: any) {
      if (signal.aborted) throw err;
      // psql exits non-zero only when it could not run at all (bad connection, missing file).
      throw new Error(`psql failed: ${lastLines(String(err?.stderr ?? '')) || err?.message}`);
    }
    const errors = stderr.split('\n').filter((l) => /^psql:.*\bERROR:/.test(l)).map((l) => l.trim());
    return { errorCount: errors.length, errors };
  }

  private async countRestored(verifyDb: string): Promise<TableCountsFile> {
    const admin = this.adminConnection();
    const client = new Client({ ...admin, database: verifyDb });
    await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const counts = await collectTableCounts(client, { maxTables: 1000, perTableTimeoutMs: 60_000 });
      await client.query('ROLLBACK').catch(() => undefined);
      return counts;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Drop verification databases a previous process left behind (it died mid-run). */
  async sweepStaleVerifyDatabases(pool: Pool): Promise<string[]> {
    const res = await pool.query<{ datname: string }>(
      `select datname from pg_database where datname like $1`,
      [`${VERIFY_DB_PREFIX}%`],
    );
    const dropped: string[] = [];
    for (const { datname } of res.rows) {
      const stamp = Number.parseInt(datname.slice(VERIFY_DB_PREFIX.length).split('_')[0] ?? '', 10);
      const ageMs = Number.isFinite(stamp) ? Date.now() - stamp * 1000 : Number.POSITIVE_INFINITY;
      if (ageMs < STALE_VERIFY_DB_MS) continue;
      await pool
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`)
        .then(() => dropped.push(datname))
        .catch((err: any) => this.logger.warn(`Stale verification database ${datname} not dropped: ${err?.message}`));
    }
    if (dropped.length) this.logger.warn(`Dropped stale verification database(s): ${dropped.join(', ')}`);
    return dropped;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Newest auto-backup object per project (or for one project). */
  private async newestAutoBackups(
    projectId?: string,
  ): Promise<Map<string, { name: string; size: number; lastModified: Date }>> {
    await this.storage.ensurePlatformBucket(AUTO_BACKUP_BUCKET).catch(() => undefined);
    const objects: { name: string; size: number; lastModified: Date }[] = await this.storage
      .listPlatformObjects(AUTO_BACKUP_BUCKET, projectId ? `${projectId}/` : '')
      .catch(() => []);
    const newest = new Map<string, { name: string; size: number; lastModified: Date }>();
    for (const o of objects) {
      const pid = o.name.split('/')[0];
      if (!pid) continue;
      const cur = newest.get(pid);
      if (!cur || o.lastModified.getTime() > cur.lastModified.getTime()) newest.set(pid, o);
    }
    return newest;
  }

  private adminConnection() {
    return {
      host: this.config.get<string>('database.host') || 'postgres',
      port: Number(this.config.get<number>('database.port') || 5432),
      user: this.config.get<string>('database.user') || 'postgres',
      password: this.config.get<string>('database.password') || '',
    };
  }

  private adminPool(): Pool {
    return new Pool({ ...this.adminConnection(), database: 'postgres', max: 1 });
  }

  /** Size and free space of the volume holding `path`, or null where it cannot be read. */
  private async diskUsage(path: string): Promise<DiskUsage | null> {
    try {
      const fsp: any = await import('fs/promises');
      if (typeof fsp.statfs !== 'function') return null;
      const s = await fsp.statfs(path);
      const bsize = Number(s.bsize);
      return { totalBytes: Number(s.blocks) * bsize, freeBytes: Number(s.bavail) * bsize };
    } catch {
      return null;
    }
  }

  private async assertMember(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { id: true, teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a member of this team');
    return project;
  }

  private async report(
    projectId: string,
    status: BackupVerificationStatus,
    summary: string,
    opts: VerificationOptions,
    verificationId: string,
  ) {
    const failed = status === 'FAILED';
    await this.activity.append(projectId, {
      userId: opts.requestedBy ?? null,
      kind: failed ? ProjectActivityKind.PROJECT_BACKUP_VERIFICATION_FAILED : ProjectActivityKind.PROJECT_BACKUP_VERIFIED,
      title: failed
        ? 'Backup restore verification failed'
        : status === 'PASSED'
          ? 'Backup restore verified'
          : 'Backup restore verification skipped',
      detail: summary,
      metadata: { verificationId, status, trigger: opts.trigger },
    });
    if (failed) {
      await this.prisma.rootAlert
        .create({
          data: {
            kind: 'backup.verification_failed',
            severity: 'HIGH',
            title: 'A backup could not be restored cleanly',
            message: `Project ${projectId}: ${summary} (verification ${verificationId})`,
          },
        })
        .catch(() => undefined);
    }
    this.logger.log(`Restore verification ${status} for project ${projectId}: ${summary}`);
  }

  private toSummary(r: {
    id: string;
    projectId: string;
    trigger: string;
    status: BackupVerificationStatus;
    backupObjectKey: string | null;
    backupTakenAt: Date | null;
    archiveBytes: bigint | null;
    tablesExpected: number | null;
    tablesRestored: number | null;
    rowsMismatched: number | null;
    psqlErrorCount: number | null;
    countsCompared: boolean;
    details: unknown;
    error: string | null;
    requestedBy: string | null;
    startedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
  }): VerificationSummary {
    return {
      id: r.id,
      projectId: r.projectId,
      trigger: r.trigger,
      status: r.status,
      backupObjectKey: r.backupObjectKey,
      backupTakenAt: r.backupTakenAt ? r.backupTakenAt.toISOString() : null,
      archiveBytes: r.archiveBytes == null ? null : Number(r.archiveBytes),
      tablesExpected: r.tablesExpected,
      tablesRestored: r.tablesRestored,
      rowsMismatched: r.rowsMismatched,
      psqlErrorCount: r.psqlErrorCount,
      countsCompared: r.countsCompared,
      details: r.details ?? null,
      error: r.error,
      requestedBy: r.requestedBy,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      durationMs: r.durationMs,
    };
  }
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

/**
 * Why the volume cannot take a drill that needs `neededBytes`, or null when it
 * can. Two limits: the space must exist, and the volume's projected usage must
 * stay at or below `maxPercent` — a drill that fits but leaves the disk nearly
 * full is refused too. Unknown usage (statfs unavailable) is not a reason to skip.
 */
export function describeDiskShortage(
  usage: DiskUsage | null,
  neededBytes: number,
  maxPercent: number,
): string | null {
  if (!usage || !(usage.totalBytes > 0)) return null;
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  if (usage.freeBytes < neededBytes) {
    return `insufficient temp space: ${mb(usage.freeBytes)} MB free, need ${mb(neededBytes)} MB`;
  }
  const usedNow = usage.totalBytes - usage.freeBytes;
  const nowPercent = (usedNow / usage.totalBytes) * 100;
  const projectedPercent = ((usedNow + neededBytes) / usage.totalBytes) * 100;
  if (projectedPercent > maxPercent) {
    return `disk would reach ${projectedPercent.toFixed(1)}% during the drill (now ${nowPercent.toFixed(1)}%, limit ${maxPercent}% — BACKUP_VERIFY_MAX_DISK_PERCENT)`;
  }
  return null;
}

function lastLines(text: string, n = 5): string {
  return text.trim().split('\n').slice(-n).join('\n').slice(0, 800);
}

/**
 * Stream the wanted entries of a zip to `outDir` without loading the archive
 * into memory (a backup can be larger than the API's heap). Each entry is
 * written under its basename; only names from `wanted` are ever opened.
 */
export function extractZipEntries(zipPath: string, wanted: Set<string>, outDir: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('could not open archive'));
      const found = new Map<string, string>();
      let failed = false;
      const fail = (e: Error) => {
        if (failed) return;
        failed = true;
        try {
          zip.close();
        } catch {
          // already closed
        }
        reject(e);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!failed) resolve(found);
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!wanted.has(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) return fail(e ?? new Error(`could not read ${entry.fileName}`));
          const out = join(outDir, basename(entry.fileName));
          pipeline(rs, createWriteStream(out))
            .then(() => {
              found.set(entry.fileName, out);
              zip.readEntry();
            })
            .catch(fail);
        });
      });
      zip.readEntry();
    });
  });
}
