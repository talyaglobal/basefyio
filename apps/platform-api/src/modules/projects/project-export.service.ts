import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ProjectsService } from './projects.service';
import { ProjectArchiveImportService } from './project-archive-import.service';
import { EXPORT_QUEUE } from '../queue/queue.module';
import type {
  ExportJobData,
  ExportJobResult,
} from '../queue/export.processor';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';
import {
  BackupDecryptError,
  ENCRYPTED_SUFFIX,
  createDecryptStream,
  getBackupKey,
} from './backups/backup-crypto';
import {
  MANUAL_EXPORT_TTL_HOURS,
  MAX_ON_DEMAND_BACKUPS,
  autoBackupRetentionDays,
  backupTrigger,
} from './backups/retention';

const EXPORT_BUCKET = 'bf-platform-exports';
const EXPORT_TTL_MS = MANUAL_EXPORT_TTL_HOURS * 60 * 60 * 1000;

/** Daily auto-backups live in their own bucket with a longer retention (AUTO_BACKUP_RETENTION_DAYS). */
const AUTO_BACKUP_BUCKET = 'bf-platform-auto-backups';

@Injectable()
export class ProjectExportService {
  private readonly logger = new Logger(ProjectExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projectsService: ProjectsService,
    private readonly projectArchiveImport: ProjectArchiveImportService,
    @InjectQueue(EXPORT_QUEUE) private readonly exportQueue: Queue,
    private readonly activity: ProjectActivityService,
  ) {}

  async startExport(
    projectId: string,
    userId: string,
    options?: {
      includeDatabase?: boolean;
      includeAuth?: boolean;
      includeStorage?: boolean;
      includeConfig?: boolean;
    },
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, slug: true, status: true },
    });
    if (!project || project.status === 'DELETED') {
      throw new NotFoundException('Project not found');
    }

    await this.projectsService.findOne(projectId, userId);

    // Some production Redis/BullMQ setups can keep a queue paused after restarts.
    // Ensure export queue is resumed before enqueueing a new job.
    try {
      const paused = await this.exportQueue.isPaused();
      if (paused) {
        await this.exportQueue.resume();
      }
    } catch {
      // Ignore queue state probe issues here; add() call below will still surface real errors.
    }

    const data: ExportJobData = {
      projectId,
      userId,
      includeDatabase: options?.includeDatabase !== false,
      includeAuth: options?.includeAuth !== false,
      includeStorage: options?.includeStorage !== false,
      includeConfig: options?.includeConfig !== false,
    };

    const job = await this.exportQueue.add('project-export', data, {
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 48 * 60 * 60, count: 100 },
      attempts: 1,
    });

    // Leave a trail for the Project logs page — the export.processor will
    // append a completion entry when the job finishes, but without this the
    // user sees nothing in between starting the export and (often minutes
    // later) the completion arriving.
    const parts: string[] = [];
    if (data.includeDatabase) parts.push('database');
    if (data.includeAuth) parts.push('auth');
    if (data.includeStorage) parts.push('storage');
    if (data.includeConfig) parts.push('config');
    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.PROJECT_EXPORT_STARTED,
      title: 'Project export started',
      detail: `Including: ${parts.length ? parts.join(', ') : 'nothing'}`,
      metadata: { jobId: String(job.id), ...data },
    });

    return { jobId: String(job.id) };
  }

  async getJobStatus(projectId: string, jobId: string, userId: string) {
    await this.projectsService.findOne(projectId, userId);
    const job = await this.exportQueue.getJob(jobId);
    if (!job) return null;

    const data = job.data as ExportJobData;
    if (data.projectId !== projectId) {
      throw new ForbiddenException('Export job does not belong to this project');
    }

    const state = await job.getState();
    return {
      id: job.id,
      state,
      progress: job.progress,
      result: state === 'completed' ? (job.returnvalue as ExportJobResult) : undefined,
      failedReason: state === 'failed' ? job.failedReason : undefined,
    };
  }

  async getExportFile(projectId: string, jobId: string, userId: string) {
    await this.projectsService.findOne(projectId, userId);
    const job = await this.exportQueue.getJob(jobId);
    if (!job) throw new NotFoundException('Export job not found');

    const data = job.data as ExportJobData;
    if (data.projectId !== projectId) {
      throw new ForbiddenException('Export job does not belong to this project');
    }

    const state = await job.getState();
    if (state !== 'completed') {
      throw new ForbiddenException('Export is not completed yet');
    }

    const result = job.returnvalue as ExportJobResult | undefined;
    if (!result?.bucket || !result?.objectKey) {
      throw new NotFoundException('Export file not found');
    }

    const file = await this.storage.getPlatformObject(result.bucket, result.objectKey);
    return {
      ...file,
      filename: result.filename,
      bucket: result.bucket,
      objectKey: result.objectKey,
    };
  }

  async cleanupExport(projectId: string, jobId: string, userId: string) {
    await this.projectsService.findOne(projectId, userId);
    const job = await this.exportQueue.getJob(jobId);
    if (!job) return;

    const data = job.data as ExportJobData;
    if (data.projectId !== projectId) return;

    const result = job.returnvalue as ExportJobResult | undefined;
    if (result?.bucket && result?.objectKey) {
      await this.storage.removePlatformObject(result.bucket, result.objectKey);
    }
  }

  async listCloudBackups(projectId: string, userId: string) {
    await this.projectsService.findOne(projectId, userId);
    await this.storage.ensurePlatformBucket(EXPORT_BUCKET);
    await this.storage.ensurePlatformBucket(AUTO_BACKUP_BUCKET);

    const [manual, auto] = await Promise.all([
      this.storage.listPlatformObjects(EXPORT_BUCKET, `${projectId}/`),
      this.storage.listPlatformObjects(AUTO_BACKUP_BUCKET, `${projectId}/`),
    ]);

    const autoDays = autoBackupRetentionDays();
    const toEntry = (o: { name: string; size: number; lastModified: Date }, kind: 'manual' | 'auto') => {
      const trigger = kind === 'manual' ? 'export' : backupTrigger(o.name);
      const keepMs = kind === 'manual' ? EXPORT_TTL_MS : autoDays * 24 * 60 * 60 * 1000;
      return {
        objectKey: o.name,
        filename: o.name.split('/').pop() || o.name,
        size: o.size,
        lastModified: o.lastModified.toISOString(),
        kind,
        /** Stored encrypted at rest (BACKUP_ENCRYPT_LOCAL); restore decrypts transparently. */
        encrypted: o.name.endsWith(ENCRYPTED_SUFFIX),
        /** export = manual download package, scheduled = nightly, on-demand = "Back up now". */
        trigger,
        /** When the retention sweep removes it. */
        expiresAt: new Date(o.lastModified.getTime() + keepMs).toISOString(),
        retentionDays: kind === 'manual' ? MANUAL_EXPORT_TTL_HOURS / 24 : autoDays,
        /** Nightly backups are the safety net and cannot be deleted by hand. */
        deletable: trigger !== 'scheduled',
      };
    };

    return [
      ...manual.map((o) => toEntry(o, 'manual' as const)),
      ...auto.map((o) => toEntry(o, 'auto' as const)),
    ].sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  }

  async restoreCloudBackup(
    projectId: string,
    userId: string,
    body: {
      objectKey: string;
      teamId: string;
      nameMode?: 'existing' | 'new';
      newProjectName?: string;
      existingProjectId?: string;
      /** Which backup store the objectKey lives in. Default: manual exports. */
      kind?: 'manual' | 'auto';
      /** Optional typed confirmation for an overwrite; must equal the target project's name. */
      confirmProjectName?: string;
    },
  ) {
    await this.projectsService.findOne(projectId, userId);
    const objectKey = body.objectKey?.trim();
    if (!objectKey?.startsWith(`${projectId}/`)) {
      throw new ForbiddenException('Backup does not belong to this project');
    }
    const bucket = body.kind === 'auto' ? AUTO_BACKUP_BUCKET : EXPORT_BUCKET;
    const { stream } = await this.openBackupObject(bucket, objectKey);
    // Archives stored with BACKUP_ENCRYPT_LOCAL carry the .enc suffix; decrypt on the way in.
    let source: Readable = stream;
    if (objectKey.endsWith(ENCRYPTED_SUFFIX)) {
      const key = getBackupKey();
      if (!key) {
        throw new BadRequestException(
          'This backup is encrypted; BACKUP_ENC_KEY is missing or does not match',
        );
      }
      const decrypt = createDecryptStream(key);
      stream.on('error', (err) => decrypt.destroy(err));
      source = stream.pipe(decrypt);
    }
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of source) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (err) {
      if (err instanceof BackupDecryptError) {
        throw new BadRequestException(`This backup could not be decrypted: ${err.message}`);
      }
      throw err;
    }
    const zipBuffer = Buffer.concat(chunks);
    return this.projectArchiveImport.importArchiveBuffer(zipBuffer, userId, {
      teamId: body.teamId,
      nameMode: body.nameMode || 'existing',
      newProjectName: body.newProjectName,
      existingProjectId: body.existingProjectId,
      confirmProjectName: body.confirmProjectName,
    });
  }

  /** Stat + stream a backup object, turning "no such key" into a 404. */
  private async openBackupObject(bucket: string, objectKey: string) {
    try {
      return await this.storage.getPlatformObject(bucket, objectKey);
    } catch (err: any) {
      if (err?.code === 'NoSuchKey' || err?.code === 'NotFound') {
        throw new NotFoundException('This backup no longer exists; it may have expired.');
      }
      throw err;
    }
  }

  private assertOwnKey(projectId: string, objectKey: string | undefined): string {
    const key = objectKey?.trim();
    if (!key?.startsWith(`${projectId}/`) || key.includes('..')) {
      throw new ForbiddenException('Backup does not belong to this project');
    }
    return key;
  }

  /**
   * Download one backup archive. Archives encrypted at rest are decrypted on
   * the way out, so the file is always a plain ZIP that Import from ZIP takes.
   */
  async downloadCloudBackup(
    projectId: string,
    userId: string,
    objectKeyRaw: string,
    kind: 'manual' | 'auto' = 'manual',
  ): Promise<{ stream: Readable; filename: string; size?: number }> {
    await this.projectsService.findOne(projectId, userId);
    const objectKey = this.assertOwnKey(projectId, objectKeyRaw);
    const bucket = kind === 'auto' ? AUTO_BACKUP_BUCKET : EXPORT_BUCKET;
    const { stream, stat } = await this.openBackupObject(bucket, objectKey);
    const leaf = objectKey.split('/').pop() || 'backup.zip';
    if (!objectKey.endsWith(ENCRYPTED_SUFFIX)) {
      return { stream, filename: leaf, size: stat.size };
    }
    const key = getBackupKey();
    if (!key) {
      stream.destroy();
      // The operator-side cause (BACKUP_ENC_KEY unset) is not the customer's to fix.
      this.logger.warn(`Encrypted backup ${objectKey} requested but BACKUP_ENC_KEY is not set`);
      throw new BadRequestException(
        'This backup is encrypted and this server cannot decrypt it right now. Contact the platform operator.',
      );
    }
    const decrypt = createDecryptStream(key);
    stream.on('error', (err) => decrypt.destroy(err));
    return { stream: stream.pipe(decrypt), filename: leaf.slice(0, -ENCRYPTED_SUFFIX.length) };
  }

  /**
   * Delete a manual export or an on-demand backup. Nightly backups are the
   * safety net and expire on their own schedule, so they cannot be deleted here.
   */
  async deleteCloudBackup(
    projectId: string,
    userId: string,
    objectKeyRaw: string,
    kind: 'manual' | 'auto' = 'manual',
  ): Promise<{ deleted: string }> {
    await this.projectsService.findOne(projectId, userId);
    const objectKey = this.assertOwnKey(projectId, objectKeyRaw);
    if (kind === 'auto' && backupTrigger(objectKey) === 'scheduled') {
      throw new BadRequestException(
        `Nightly backups cannot be deleted; they are removed automatically after ${autoBackupRetentionDays()} days.`,
      );
    }
    const bucket = kind === 'auto' ? AUTO_BACKUP_BUCKET : EXPORT_BUCKET;
    await this.openBackupObject(bucket, objectKey).then(({ stream }) => stream.destroy());
    await this.storage.removePlatformObject(bucket, objectKey);
    await this.activity
      .append(projectId, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: kind === 'auto' ? 'On-demand backup deleted' : 'Export archive deleted',
        detail: objectKey.split('/').pop(),
      })
      .catch(() => undefined);
    return { deleted: objectKey };
  }

  /**
   * "Back up now": the same archive the nightly run makes (database, auth and
   * config; storage objects already live in object storage), kept for the
   * nightly retention. One may run at a time per project, and a project holds
   * at most MAX_ON_DEMAND_BACKUPS of them, so repeated clicks cannot fill the disk.
   */
  async startOnDemandBackup(projectId: string, userId: string): Promise<{ jobId: string }> {
    await this.projectsService.findOne(projectId, userId);

    const pending: Job[] = await this.exportQueue.getJobs(['waiting', 'active', 'delayed']).catch(() => []);
    if (pending.some((j) => (j?.data as ExportJobData | undefined)?.projectId === projectId && (j?.data as ExportJobData).autoBackup)) {
      throw new ConflictException('A backup of this project is already running. Wait for it to finish.');
    }

    await this.storage.ensurePlatformBucket(AUTO_BACKUP_BUCKET);
    const existing = await this.storage.listPlatformObjects(AUTO_BACKUP_BUCKET, `${projectId}/`);
    const onDemand = existing.filter((o) => backupTrigger(o.name) === 'on-demand');
    if (onDemand.length >= MAX_ON_DEMAND_BACKUPS) {
      throw new BadRequestException(
        `This project already has ${onDemand.length} on-demand backups. Delete one before taking another; ` +
          `they are also removed automatically after ${autoBackupRetentionDays()} days.`,
      );
    }

    try {
      if (await this.exportQueue.isPaused()) await this.exportQueue.resume();
    } catch {
      // add() below surfaces real queue errors.
    }
    const data: ExportJobData = {
      projectId,
      userId,
      includeDatabase: true,
      includeAuth: true,
      includeStorage: false,
      includeConfig: true,
      autoBackup: true,
      onDemand: true,
    };
    const job = await this.exportQueue.add('project-export', data, {
      removeOnComplete: { age: 24 * 60 * 60, count: 500 },
      removeOnFail: { age: 48 * 60 * 60, count: 500 },
      attempts: 1,
    });
    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.PROJECT_EXPORT_STARTED,
      title: 'On-demand backup started',
      detail: 'Database, auth and config',
      metadata: { jobId: String(job.id), onDemand: true },
    });
    return { jobId: String(job.id) };
  }

  getExportBucketName(): string {
    return EXPORT_BUCKET;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredExports() {
    await this.storage.ensurePlatformBucket(EXPORT_BUCKET);
    const objects = await this.storage.listPlatformObjects(EXPORT_BUCKET);
    const now = Date.now();

    for (const object of objects) {
      if (now - object.lastModified.getTime() > EXPORT_TTL_MS) {
        await this.storage.removePlatformObject(EXPORT_BUCKET, object.name);
      }
    }
  }

  // ── Daily auto-backups ───────────────────────────────────

  /**
   * Enqueue one backup job per ACTIVE project every night at 03:00 UTC.
   * Storage objects are intentionally excluded: they already live in MinIO,
   * and re-zipping them daily would multiply disk usage — the loss vector
   * a backup protects against is the database (plus auth/config).
   */
  @Cron('0 3 * * *')
  async runDailyAutoBackups() {
    const projects = await this.prisma.project.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true },
    });
    if (projects.length === 0) return;

    try {
      const paused = await this.exportQueue.isPaused();
      if (paused) await this.exportQueue.resume();
    } catch {
      // add() below surfaces real queue errors.
    }

    let enqueued = 0;
    for (const project of projects) {
      try {
        const data: ExportJobData = {
          projectId: project.id,
          includeDatabase: true,
          includeAuth: true,
          includeStorage: false,
          includeConfig: true,
          autoBackup: true,
        };
        await this.exportQueue.add('project-export', data, {
          removeOnComplete: { age: 24 * 60 * 60, count: 500 },
          removeOnFail: { age: 48 * 60 * 60, count: 500 },
          attempts: 1,
        });
        enqueued++;
      } catch (err: any) {
        this.logger.warn(
          `Auto-backup enqueue failed for project ${project.slug}: ${err?.message}`,
        );
      }
    }
    this.logger.log(`Daily auto-backup: enqueued ${enqueued}/${projects.length} project(s)`);
  }

  /** Drop auto-backups older than the retention window (runs after the nightly sweep). */
  @Cron('30 4 * * *')
  async cleanupOldAutoBackups() {
    await this.storage.ensurePlatformBucket(AUTO_BACKUP_BUCKET);
    const objects = await this.storage.listPlatformObjects(AUTO_BACKUP_BUCKET);
    const retentionDays = autoBackupRetentionDays();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    let removed = 0;
    for (const object of objects) {
      if (object.lastModified.getTime() < cutoff) {
        try {
          await this.storage.removePlatformObject(AUTO_BACKUP_BUCKET, object.name);
          removed++;
        } catch (err: any) {
          this.logger.warn(`Auto-backup cleanup failed for ${object.name}: ${err?.message}`);
        }
      }
    }
    if (removed > 0) {
      this.logger.log(`Auto-backup retention: removed ${removed} object(s) older than ${retentionDays} days`);
    }
  }
}
