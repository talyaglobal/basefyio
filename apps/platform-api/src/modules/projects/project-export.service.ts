import {
  ForbiddenException,
  Injectable,
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

const EXPORT_BUCKET = 'kb-platform-exports';
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ProjectExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projectsService: ProjectsService,
    private readonly projectArchiveImport: ProjectArchiveImportService,
    @InjectQueue(EXPORT_QUEUE) private readonly exportQueue: Queue,
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
    const objects = await this.storage.listPlatformObjects(EXPORT_BUCKET, `${projectId}/`);
    return objects
      .map((o) => ({
        objectKey: o.name,
        filename: o.name.split('/').pop() || o.name,
        size: o.size,
        lastModified: o.lastModified.toISOString(),
      }))
      .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
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
    },
  ) {
    await this.projectsService.findOne(projectId, userId);
    const objectKey = body.objectKey?.trim();
    if (!objectKey?.startsWith(`${projectId}/`)) {
      throw new ForbiddenException('Backup does not belong to this project');
    }
    const { stream } = await this.storage.getPlatformObject(EXPORT_BUCKET, objectKey);
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
}
