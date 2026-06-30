import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseImportService, ImportProgress } from '../projects/supabase-import.service';
import { IMPORT_QUEUE } from './queue.module';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';

class CancelledError extends Error {
  constructor() {
    super('Import cancelled by user');
    this.name = 'CancelledError';
  }
}

export interface ImportJobData {
  projectId: string;
  projectName: string;
  /** User who started the import (activity log attribution). */
  userId?: string;
  baseUrl: string;
  serviceRoleKey: string;
  /** Source Supabase DB password for direct PG copy (bypasses PostgREST 403 on some tables). */
  supabaseDatabasePassword?: string;
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  keycloakRealm: string;
  /** When true, cancelImport must not delete the project (re-import into existing project). */
  preserveProjectOnCancel?: boolean;
}

export interface ImportJobProgress {
  step: 'database' | 'auth' | 'storage' | 'completed' | 'failed';
  detail: string;
  percent: number;
  progress?: ImportProgress;
  error?: string;
  /** Active fetch strategy label (e.g. "PostgREST", "Direct SQL", "HTTP REST", "CSV") */
  strategy?: string;
}

@Injectable()
@Processor(IMPORT_QUEUE, {
  concurrency: 2,
  lockDuration: 60_000,
  stalledInterval: 15_000,
  maxStalledCount: 2,
})
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(
    private readonly importService: SupabaseImportService,
    private readonly prisma: PrismaService,
    private readonly activity: ProjectActivityService,
  ) {
    super();
  }

  @OnWorkerEvent('ready')
  onReady() {
    this.logger.log('Supabase import worker is ready');
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.error(`Supabase import worker error: ${error.message}`, error.stack);
  }

  async process(job: Job<ImportJobData>): Promise<ImportProgress> {
    const JOB_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Import job timed out after 45 minutes')),
        JOB_TIMEOUT_MS,
      );
    });

    try {
      return await Promise.race([this.runImport(job), timeoutPromise]);
    } catch (err: any) {
      const uid = job.data.userId;
      const pid = job.data.projectId;
      if (err instanceof CancelledError) {
        await this.activity.append(pid, {
          userId: uid,
          kind: ProjectActivityKind.SUPABASE_IMPORT_CANCELLED,
          title: 'Supabase import cancelled',
          detail: 'Import was cancelled before completion.',
        });
      } else {
        await this.activity.append(pid, {
          userId: uid,
          kind: ProjectActivityKind.SUPABASE_IMPORT_FAILED,
          title: 'Supabase import failed',
          detail: err?.message?.slice(0, 2000) ?? String(err),
        });
      }
      throw err;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private async runImport(job: Job<ImportJobData>): Promise<ImportProgress> {
    const jobId = String(job.id);
    const { baseUrl, serviceRoleKey, projectId, projectName } = job.data;

    this.logger.log(
      `[Job ${jobId}] Starting import for "${projectName}" (project=${projectId}, db=${job.data.dbName}@${job.data.dbHost}:${job.data.dbPort})`,
    );

    const headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    };

    const project = {
      id: projectId,
      dbHost: job.data.dbHost,
      dbPort: job.data.dbPort,
      dbUser: job.data.dbUser,
      dbPassword: job.data.dbPassword,
      dbName: job.data.dbName,
      keycloakRealm: job.data.keycloakRealm,
      supabaseDatabasePassword: job.data.supabaseDatabasePassword,
    };

    const progress: ImportProgress = {
      database: { tables: 0, rows: 0, failedTables: [] },
      auth: { users: 0, skipped: 0 },
      storage: { buckets: 0, objects: 0 },
      warnings: [],
    };

    const checkCancelled = () => {
      if (this.importService.isJobCancelled(jobId)) {
        throw new CancelledError();
      }
    };

    const onProgress = async (update: ImportJobProgress) => {
      checkCancelled();
      await job.updateProgress(update);
    };

    try {
      // Database import
      try {
        await onProgress({ step: 'database', detail: 'Starting database import...', percent: 5 });
        await this.importService.runDatabaseImport(
          baseUrl, headers, project, progress,
          async (detail: string, percent: number, strategy?: string) => {
            await onProgress({ step: 'database', detail, percent, strategy });
          },
        );
        checkCancelled();
        await onProgress({
          step: 'database',
          detail: `${progress.database.tables} tables, ${progress.database.rows} rows`,
          percent: 50,
          progress,
        });
      } catch (err: any) {
        if (err instanceof CancelledError) throw err;
        this.logger.error(`DB import failed: ${err.message}`, err.stack);
        progress.warnings.push(`Database import partially failed: ${err.message}`);
      }

      checkCancelled();

      // Auth import
      try {
        await onProgress({ step: 'auth', detail: 'Importing auth users...', percent: 55 });
        await this.importService.runAuthImport(
          baseUrl, headers, project, progress, projectName,
        );
        checkCancelled();
        await onProgress({
          step: 'auth',
          detail: `${progress.auth.users} users imported`,
          percent: 80,
          progress,
        });
      } catch (err: any) {
        if (err instanceof CancelledError) throw err;
        this.logger.error(`Auth import failed: ${err.message}`, err.stack);
        progress.warnings.push(`Auth import failed: ${err.message}`);
      }

      checkCancelled();

      // Storage import
      try {
        await onProgress({ step: 'storage', detail: 'Importing storage files...', percent: 85 });
        await this.importService.runStorageImport(
          baseUrl, headers, project, progress,
        );
        checkCancelled();
        await onProgress({
          step: 'storage',
          detail: `${progress.storage.buckets} buckets, ${progress.storage.objects} objects`,
          percent: 95,
          progress,
        });
      } catch (err: any) {
        if (err instanceof CancelledError) throw err;
        this.logger.error(`Storage import failed: ${err.message}`, err.stack);
        progress.warnings.push(`Storage import failed: ${err.message}`);
      }

      checkCancelled();

    } catch (err: any) {
      if (err instanceof CancelledError) {
        this.logger.log(`[Job ${jobId}] Cancelled by user`);
        await job.updateProgress({
          step: 'failed',
          detail: 'Import cancelled by user',
          percent: 0,
          error: 'Cancelled',
        });
        throw err;
      }
      this.logger.error(`[Job ${jobId}] Unhandled error: ${err.message}`, err.stack);
      throw err;
    }

    this.logger.log(
      `Import job ${jobId} complete: ` +
      `${progress.database.tables} tables, ${progress.database.rows} rows, ` +
      `${progress.auth.users} users, ${progress.storage.buckets} buckets, ` +
      `${progress.storage.objects} objects`,
    );

    const logPayload: Prisma.InputJsonValue = {
      database: progress.database,
      auth: progress.auth,
      storage: progress.storage,
      warnings: progress.warnings,
      completedAt: new Date().toISOString(),
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.prisma.project.update({
          where: { id: projectId },
          data: { supabaseImportLog: logPayload },
        });
        this.logger.log(`Import log persisted for project ${projectId}`);
        await this.activity.append(projectId, {
          userId: job.data.userId,
          kind: ProjectActivityKind.SUPABASE_IMPORT_COMPLETED,
          title: 'Supabase import completed',
          detail: `${progress.database.tables} tables, ${progress.database.rows} rows; ${progress.auth.users} users; ${progress.storage.buckets} buckets, ${progress.storage.objects} objects.`,
          metadata: {
            tables: progress.database.tables,
            rows: progress.database.rows,
            authUsers: progress.auth.users,
            storageBuckets: progress.storage.buckets,
            storageObjects: progress.storage.objects,
            warningCount: progress.warnings.length,
          },
        });
        break;
      } catch (err: any) {
        this.logger.warn(
          `Failed to persist import log for project ${projectId} (attempt ${attempt}/3): ${err.message}`,
        );
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 1000));
        }
      }
    }

    await job.updateProgress({
      step: 'completed',
      detail: 'Import complete',
      percent: 100,
      progress,
    });

    return progress;
  }
}
