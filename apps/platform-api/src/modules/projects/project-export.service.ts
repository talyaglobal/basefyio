import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
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

const EXPORT_BUCKET = 'bf-platform-exports';
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** Daily auto-backups live in their own bucket with a longer retention. */
const AUTO_BACKUP_BUCKET = 'bf-platform-auto-backups';
const AUTO_BACKUP_RETENTION_DAYS = 7;

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

    const toEntry = (o: { name: string; size: number; lastModified: Date }, kind: 'manual' | 'auto') => ({
      objectKey: o.name,
      filename: o.name.split('/').pop() || o.name,
      size: o.size,
      lastModified: o.lastModified.toISOString(),
      kind,
    });

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
    },
  ) {
    await this.projectsService.findOne(projectId, userId);
    const objectKey = body.objectKey?.trim();
    if (!objectKey?.startsWith(`${projectId}/`)) {
      throw new ForbiddenException('Backup does not belong to this project');
    }
    const bucket = body.kind === 'auto' ? AUTO_BACKUP_BUCKET : EXPORT_BUCKET;
    const { stream } = await this.storage.getPlatformObject(bucket, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const zipBuffer = Buffer.concat(chunks);
    return this.projectArchiveImport.importArchiveBuffer(zipBuffer, userId, {
      teamId: body.teamId,
      nameMode: body.nameMode || 'existing',
      newProjectName: body.newProjectName,
      existingProjectId: body.existingProjectId,
    });
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
    const cutoff = Date.now() - AUTO_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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
      this.logger.log(`Auto-backup retention: removed ${removed} object(s) older than ${AUTO_BACKUP_RETENTION_DAYS} days`);
    }
  }
}
