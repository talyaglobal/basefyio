import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SupabaseImportService, ImportProgress } from '../projects/supabase-import.service';
import { IMPORT_QUEUE } from './queue.module';

class CancelledError extends Error {
  constructor() {
    super('Import cancelled by user');
    this.name = 'CancelledError';
  }
}

export interface ImportJobData {
  projectId: string;
  projectName: string;
  baseUrl: string;
  serviceRoleKey: string;
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  keycloakRealm: string;
}

export interface ImportJobProgress {
  step: 'database' | 'auth' | 'storage' | 'completed' | 'failed';
  detail: string;
  percent: number;
  progress?: ImportProgress;
  error?: string;
}

@Processor(IMPORT_QUEUE, { concurrency: 2 })
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(
    private readonly importService: SupabaseImportService,
  ) {
    super();
  }

  async process(job: Job<ImportJobData>): Promise<ImportProgress> {
    const jobId = String(job.id);
    const { baseUrl, serviceRoleKey, projectId, projectName } = job.data;

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
          async (detail: string, percent: number) => {
            await onProgress({ step: 'database', detail, percent });
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
        this.logger.log(`Import job ${jobId} cancelled by user, aborting processor`);
        await job.updateProgress({
          step: 'failed',
          detail: 'Import cancelled by user',
          percent: 0,
          error: 'Cancelled',
        });
        throw err;
      }
      throw err;
    }

    if (progress.database.failedTables.length > 0) {
      progress.warnings.push(
        `Data import failed for tables: ${progress.database.failedTables.join(', ')}`,
      );
    }

    this.logger.log(
      `Import job ${jobId} complete: ` +
      `${progress.database.tables} tables, ${progress.database.rows} rows, ` +
      `${progress.auth.users} users, ${progress.storage.buckets} buckets, ` +
      `${progress.storage.objects} objects`,
    );

    await job.updateProgress({
      step: 'completed',
      detail: 'Import complete',
      percent: 100,
      progress,
    });

    return progress;
  }
}
