import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import archiver = require('archiver');
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { EXPORT_QUEUE } from './queue.module';

const execFileAsync = promisify(execFile);

export interface ExportJobData {
  projectId: string;
  userId?: string;
  includeDatabase: boolean;
  includeAuth: boolean;
  includeStorage: boolean;
  includeConfig: boolean;
}

export interface ExportJobProgress {
  step:
    | 'database'
    | 'auth'
    | 'storage'
    | 'metadata'
    | 'packaging'
    | 'completed'
    | 'failed';
  detail: string;
  percent: number;
  error?: string;
}

export interface ExportJobResult {
  bucket: string;
  objectKey: string;
  filename: string;
  size: number;
}

@Injectable()
@Processor(EXPORT_QUEUE, {
  concurrency: 1,
  lockDuration: 60_000,
  stalledInterval: 15_000,
  maxStalledCount: 2,
})
export class ExportProcessor extends WorkerHost {
  private readonly logger = new Logger(ExportProcessor.name);
  private readonly exportBucket = 'kb-platform-exports';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly keycloak: KeycloakAdminService,
    private readonly activity: ProjectActivityService,
    @InjectQueue(EXPORT_QUEUE) private readonly exportQueue: Queue,
  ) {
    super();
  }

  @OnWorkerEvent('ready')
  async onReady() {
    this.logger.log('Export worker is ready');
    try {
      const active = await this.exportQueue.getActive();
      for (const job of active) {
        try {
          await job.moveToFailed(
            new Error('Stale export job recovered after server restart'),
            job.token || '0',
            true,
          );
          this.logger.warn(`Cleaned stale active export job ${job.id}`);
        } catch {}
      }
      if (active.length > 0) {
        this.logger.warn(`Recovered ${active.length} stale active export job(s)`);
      }
    } catch (err: any) {
      this.logger.warn(`Export stale job cleanup failed: ${err.message}`);
    }
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.error(`Export worker error: ${error.message}`, error.stack);
  }

  async process(job: Job<ExportJobData>): Promise<ExportJobResult> {
    const project = await this.prisma.project.findFirst({
      where: { id: job.data.projectId, status: 'ACTIVE' },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const tempRoot = await mkdtemp(join(tmpdir(), 'kb-export-'));
    const dbDir = join(tempRoot, 'database');
    const authDir = join(tempRoot, 'auth');
    const storageDir = join(tempRoot, 'storage');
    const metadataDir = join(tempRoot, 'metadata');
    const zipPath = join(tempRoot, 'project-export.zip');

    await mkdir(dbDir, { recursive: true });
    await mkdir(authDir, { recursive: true });
    await mkdir(storageDir, { recursive: true });
    await mkdir(metadataDir, { recursive: true });

    try {
      await this.activity.append(project.id, {
        userId: job.data.userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Project export started',
      });

      if (job.data.includeDatabase) {
        await job.updateProgress({
          step: 'database',
          detail: 'Exporting PostgreSQL database',
          percent: 10,
        } satisfies ExportJobProgress);
        await this.exportDatabase(project, join(dbDir, 'dump.sql'));
      }

      if (job.data.includeAuth) {
        await job.updateProgress({
          step: 'auth',
          detail: 'Exporting auth realm and users',
          percent: 35,
        } satisfies ExportJobProgress);
        await this.exportAuth(project.id, project.keycloakRealm, authDir);
      }

      if (job.data.includeStorage) {
        await job.updateProgress({
          step: 'storage',
          detail: 'Exporting storage buckets and objects',
          percent: 55,
        } satisfies ExportJobProgress);
        await this.exportStorage(project.id, storageDir);
      }

      if (job.data.includeConfig) {
        await job.updateProgress({
          step: 'metadata',
          detail: 'Exporting project metadata',
          percent: 80,
        } satisfies ExportJobProgress);
        await this.exportMetadata(project.id, metadataDir);
      }

      await job.updateProgress({
        step: 'packaging',
        detail: 'Packaging export archive',
        percent: 92,
      } satisfies ExportJobProgress);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `project-export-${project.slug}-${timestamp}.zip`;
      const objectKey = `${project.id}/${job.id}-${filename}`;

      await this.createZipArchive(tempRoot, zipPath);
      const uploaded = await this.storage.uploadPlatformFileFromPath(
        this.exportBucket,
        objectKey,
        zipPath,
        'application/zip',
      );

      await job.updateProgress({
        step: 'completed',
        detail: 'Export completed',
        percent: 100,
      } satisfies ExportJobProgress);

      await this.activity.append(project.id, {
        userId: job.data.userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Project export completed',
        detail: filename,
      });

      return {
        bucket: this.exportBucket,
        objectKey,
        filename,
        size: uploaded.size,
      };
    } catch (err: any) {
      await this.activity.append(project.id, {
        userId: job.data.userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Project export failed',
        detail: err?.message ?? 'Unknown error',
      });
      throw err;
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async exportDatabase(
    project: {
      dbHost: string;
      dbPort: number;
      dbUser: string;
      dbPassword: string;
      dbName: string;
    },
    outputPath: string,
  ) {
    const args = [
      '--host',
      project.dbHost,
      '--port',
      String(project.dbPort),
      '--username',
      project.dbUser,
      '--dbname',
      project.dbName,
      '--format=plain',
      '--no-owner',
      '--no-acl',
      '--clean',
      '--if-exists',
      '-f',
      outputPath,
    ];

    await execFileAsync('pg_dump', args, {
      env: {
        ...process.env,
        PGPASSWORD: project.dbPassword,
        PGCONNECT_TIMEOUT: '10',
      },
    });
  }

  private async exportAuth(
    projectId: string,
    realmName: string,
    authDir: string,
  ) {
    const [users, realmInfo] = await Promise.all([
      this.keycloak.listUsers(realmName),
      this.keycloak.getRealmInfo(realmName),
    ]);
    const authConfig = await this.prisma.projectAuthConfig.findUnique({
      where: { projectId },
    });

    await writeFile(
      join(authDir, 'users.json'),
      JSON.stringify(users, null, 2),
      'utf8',
    );
    await writeFile(
      join(authDir, 'realm-config.json'),
      JSON.stringify(realmInfo, null, 2),
      'utf8',
    );
    await writeFile(
      join(authDir, 'auth-config.json'),
      JSON.stringify(authConfig, null, 2),
      'utf8',
    );
  }

  private async exportStorage(projectId: string, storageDir: string) {
    const buckets = await this.storage.listBuckets(projectId, undefined);
    await writeFile(
      join(storageDir, 'buckets.json'),
      JSON.stringify(buckets, null, 2),
      'utf8',
    );

    for (const bucket of buckets) {
      const bucketDir = join(storageDir, bucket.name);
      await mkdir(bucketDir, { recursive: true });

      const objects = await this.storage.listObjects(
        projectId,
        undefined,
        bucket.name,
        '',
        true,
      );

      for (const object of objects) {
        if (!object.name) continue;
        const outPath = join(bucketDir, object.name);
        await mkdir(join(outPath, '..'), { recursive: true });
        const { stream } = await this.storage.getObject(
          projectId,
          undefined,
          bucket.name,
          object.name,
        );
        await pipeline(stream, createWriteStream(outPath));
      }
    }
  }

  private async exportMetadata(projectId: string, metadataDir: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        folder: true,
        tags: { include: { tag: true } },
        authConfig: true,
      },
    });
    if (!project) return;

    const {
      dbPassword,
      githubToken,
      vercelToken,
      serviceKey,
      ...safeProject
    } = project;

    await writeFile(
      join(metadataDir, 'project.json'),
      JSON.stringify(safeProject, null, 2),
      'utf8',
    );

    await writeFile(
      join(metadataDir, 'manifest.json'),
      JSON.stringify(
        {
          formatVersion: 1,
          exportedAt: new Date().toISOString(),
          projectId: project.id,
          projectSlug: project.slug,
          redacted: ['dbPassword', 'githubToken', 'vercelToken', 'serviceKey'],
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  private async createZipArchive(rootDir: string, outputPath: string) {
    await this.storage.ensurePlatformBucket(this.exportBucket);
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const done = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);
    });

    archive.pipe(output);

    const databasePath = join(rootDir, 'database', 'dump.sql');
    const authPath = join(rootDir, 'auth');
    const storagePath = join(rootDir, 'storage');
    const metadataPath = join(rootDir, 'metadata');

    try {
      const dumpContents = await readFile(databasePath);
      archive.append(dumpContents, { name: 'database/dump.sql' });
    } catch {}

    archive.directory(authPath, 'auth');
    archive.directory(storagePath, 'storage');
    archive.directory(metadataPath, '');

    await archive.finalize();
    await done;
  }
}
