import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as Minio from 'minio';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DATA_IMPORT_QUEUE } from '../queue/queue.module';
import {
  detectFormat,
  samplePreview,
  DEFAULT_PREVIEW_ROWS,
  type FileFormat,
} from './lib/file-parser';
import { inferSchema } from './lib/type-inferrer';
import type {
  StartImportDto,
  InspectImportResultDto,
} from './dto/start-import.dto';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';

/**
 * Platform-wide MinIO bucket for staging upload files between /inspect and the
 * BullMQ worker. Kept distinct from project user buckets — these objects are
 * internal and short-lived (TTL'd by lifecycle policy externally, or by
 * cancellation/completion cleanup).
 */
const STAGING_BUCKET = 'bf-platform-data-imports';

@Injectable()
export class DataImportService {
  private readonly logger = new Logger(DataImportService.name);
  /** Internal client — used for staging objects from inside the platform API. */
  private readonly minio: Minio.Client;
  /**
   * Public client — used ONLY for generating presigned URLs. Configured with
   * the browser-reachable hostname so the URL it stamps in the signature
   * points where the browser can actually reach (NAT-aware deploys often
   * have an internal `minio:9000` for service-to-service plus an external
   * `cdn.example.com` for browsers).
   */
  private readonly minioPublic: Minio.Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(DATA_IMPORT_QUEUE) private readonly queue: Queue,
    private readonly activity: ProjectActivityService,
  ) {
    const accessKey = this.config.get<string>('minio.accessKey') || 'kolaybase';
    const secretKey = this.config.get<string>('minio.secretKey') || 'kolaybase_secret';
    this.minio = new Minio.Client({
      endPoint: this.config.get<string>('minio.endpoint') || 'localhost',
      port: this.config.get<number>('minio.port') || 9000,
      useSSL: this.config.get<boolean>('minio.useSsl') || false,
      accessKey,
      secretKey,
    });
    this.minioPublic = new Minio.Client({
      endPoint: this.config.get<string>('minio.publicEndpoint') || 'localhost',
      port: this.config.get<number>('minio.publicPort') || 9000,
      useSSL: this.config.get<string>('minio.publicSsl') === 'true',
      accessKey,
      secretKey,
    });
  }

  /**
   * Mint a short-lived presigned PUT URL the browser can use to upload the
   * source file DIRECTLY to MinIO, bypassing the platform-api and any
   * reverse-proxy body-size limits in between. Used for files > ~50MB that
   * would otherwise 502 through the streaming inspect proxy.
   *
   * The returned `sourceKey` is the same shape /inspect would have generated
   * — `<projectId>/<ts>-<random>/<safe-filename>` — so all the downstream
   * code (validation, start, worker) treats presigned uploads identically.
   */
  async presignUpload(
    projectId: string,
    userId: string | undefined,
    filename: string,
  ): Promise<{ sourceKey: string; uploadUrl: string; expiresInSeconds: number }> {
    await this.assertProjectAccess(projectId, userId);

    const format = detectFormat(filename);
    if (!format) {
      throw new BadRequestException(
        `Unsupported file type: ${filename}. Use .csv, .tsv, or .xlsx.`,
      );
    }

    await this.ensureStagingBucket();

    const sourceKey = `${projectId}/${Date.now()}-${randomBytes(8).toString('hex')}/${safeBasename(filename)}`;
    const expiresInSeconds = 60 * 30; // 30 minutes
    const uploadUrl = await this.minioPublic.presignedPutObject(
      STAGING_BUCKET,
      sourceKey,
      expiresInSeconds,
    );
    return { sourceKey, uploadUrl, expiresInSeconds };
  }

  /**
   * Run /inspect against a file the browser already PUT to MinIO via the
   * presigned URL flow. Fetches the FIRST ~16 MB of the object (range
   * request) — more than enough for a 1000-row preview on any sane CSV /
   * XLSX shape — keeping the wizard responsive even on multi-GB sources.
   */
  async inspectStaged(
    projectId: string,
    userId: string | undefined,
    sourceKey: string,
    filename: string,
    firstRowIsHeader: boolean = true,
  ): Promise<InspectImportResultDto> {
    await this.assertProjectAccess(projectId, userId);

    if (!sourceKey.startsWith(`${projectId}/`)) {
      throw new BadRequestException(
        'sourceKey must belong to the requesting project.',
      );
    }

    const format = detectFormat(filename);
    if (!format) {
      throw new BadRequestException(
        `Unsupported file type: ${filename}. Use .csv, .tsv, or .xlsx.`,
      );
    }

    // Verify the object actually exists and capture its true size for the
    // approximate row count display.
    let totalSize = 0;
    try {
      const stat = await this.minio.statObject(STAGING_BUCKET, sourceKey);
      totalSize = stat.size;
    } catch {
      throw new BadRequestException(
        'Staged file not found. Did the presigned upload complete?',
      );
    }

    // CSV: range-fetch the first 16 MB — enough for 1000 preview rows on
    // any reasonable schema. XLSX: needs the whole workbook to be parsed
    // (zipped) so we fetch the full object even when large. The worker only
    // does this on /inspect, not on every chunk, so the cost is bounded.
    const previewSlice = format === 'csv' ? 16 * 1024 * 1024 : totalSize;
    const buffer = await this.fetchObjectRange(sourceKey, 0, previewSlice);

    const preview = samplePreview(buffer, format, DEFAULT_PREVIEW_ROWS, firstRowIsHeader);
    if (preview.headers.length === 0) {
      throw new BadRequestException('File has no header row');
    }
    const inferred = inferSchema(preview.headers, preview.rows);

    const existingTables = await this.listExistingTables(projectId);

    return {
      sourceKey,
      filename,
      format,
      // Approximate based on object size when only the slice was read.
      totalRowsApprox:
        format === 'csv' && totalSize > previewSlice
          ? Math.round(preview.totalRowsApprox * (totalSize / previewSlice))
          : preview.totalRowsApprox,
      headers: preview.headers,
      inferredColumns: inferred,
      sampleRows: preview.rows.slice(0, 25),
      existingTables,
      firstRowIsHeader,
    };
  }

  private async fetchObjectRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    const stream = await this.minio.getPartialObject(
      STAGING_BUCKET,
      key,
      offset,
      length,
    );
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  /**
   * Inspect step: parse the first N rows for the wizard. Stores the full file
   * in MinIO under a job-prefix key so the start() call can reference it
   * without re-uploading. Returns inferred schema + sample rows + the project's
   * existing tables so the UI can render the "import into existing" picker.
   */
  async inspect(
    projectId: string,
    userId: string | undefined,
    file: { buffer: Buffer; originalname: string; mimetype?: string },
    /**
     * When false, the parser treats row 0 as data and synthesizes
     * `column_1`, `column_2`, … as header names. Surface this in the wizard
     * for CSVs that come out of legacy exports with no header line.
     */
    firstRowIsHeader: boolean = true,
  ): Promise<InspectImportResultDto> {
    await this.assertProjectAccess(projectId, userId);

    const format = detectFormat(file.originalname, file.mimetype);
    if (!format) {
      throw new BadRequestException(
        `Unsupported file type: ${file.originalname}. Use .csv, .tsv, or .xlsx.`,
      );
    }

    if (file.buffer.length === 0) {
      throw new BadRequestException('Empty file');
    }

    // Cheap sanity guard: reject obviously absurd uploads up front so we don't
    // blow memory on a 10 GB tarball someone renamed to .csv. The 1 GB cap is
    // arbitrary — adjust via env if you need bigger.
    const maxBytes = Number(this.config.get<string>('dataImport.maxBytes') || 1024 * 1024 * 1024);
    if (file.buffer.length > maxBytes) {
      throw new BadRequestException(
        `File too large: ${file.buffer.length} bytes (limit: ${maxBytes}).`,
      );
    }

    const preview = samplePreview(file.buffer, format, DEFAULT_PREVIEW_ROWS, firstRowIsHeader);
    if (preview.headers.length === 0) {
      throw new BadRequestException('File has no header row');
    }

    const inferred = inferSchema(preview.headers, preview.rows);

    // Stage the file in MinIO so /start can reference it by key.
    await this.ensureStagingBucket();
    const sourceKey = `${projectId}/${Date.now()}-${randomBytes(8).toString('hex')}/${safeBasename(file.originalname)}`;
    await this.minio.putObject(
      STAGING_BUCKET,
      sourceKey,
      file.buffer,
      file.buffer.length,
      { 'Content-Type': file.mimetype || mimeForFormat(format) },
    );

    const existingTables = await this.listExistingTables(projectId);

    return {
      sourceKey,
      filename: file.originalname,
      format,
      totalRowsApprox: preview.totalRowsApprox,
      headers: preview.headers,
      inferredColumns: inferred,
      sampleRows: preview.rows.slice(0, 25),
      existingTables,
      firstRowIsHeader,
    };
  }

  /**
   * Validate the plan and enqueue the import job. Returns the BullMQ job id;
   * the caller polls /status or subscribes to /events for progress.
   */
  async start(
    projectId: string,
    userId: string | undefined,
    dto: StartImportDto,
  ): Promise<{ jobId: string }> {
    await this.assertProjectAccess(projectId, userId);

    if (!dto.sourceKey || !dto.sourceKey.startsWith(`${projectId}/`)) {
      throw new BadRequestException(
        'Invalid sourceKey — it must belong to the same project as the request.',
      );
    }

    // Validate every additional source key the same way — it must belong to
    // the project's staging prefix. Without this we'd happily import another
    // tenant's staged file into this project's table.
    const extra = (dto.additionalSourceKeys ?? []).filter((k) => k !== dto.sourceKey);
    for (const k of extra) {
      if (!k || !k.startsWith(`${projectId}/`)) {
        throw new BadRequestException(
          `Invalid additionalSourceKey "${k}" — must belong to the same project.`,
        );
      }
    }

    if (!dto.columns.length) {
      throw new BadRequestException('At least one column mapping is required');
    }

    // Conflict policy sanity: skip/update need a conflict-target column.
    if (
      (dto.conflictMode === 'skip' || dto.conflictMode === 'update') &&
      (!dto.conflictColumns || dto.conflictColumns.length === 0)
    ) {
      throw new BadRequestException(
        `conflictMode "${dto.conflictMode}" requires at least one conflictColumns entry.`,
      );
    }

    // Verify every staged file is still in MinIO (could have been TTL'd or
    // cancelled). Done in one pass so the first-file error doesn't hide a
    // later-file error from a multi-upload session.
    const missing: string[] = [];
    for (const key of [dto.sourceKey, ...extra]) {
      try {
        await this.minio.statObject(STAGING_BUCKET, key);
      } catch {
        missing.push(key);
      }
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Source file(s) no longer exist in staging: ${missing.join(', ')}. Re-upload via /inspect.`,
      );
    }

    const job = await this.queue.add(
      'data-import',
      {
        projectId,
        userId,
        sourceKey: dto.sourceKey,
        additionalSourceKeys: extra,
        filename: dto.filename,
        format: dto.format,
        firstRowIsHeader: dto.firstRowIsHeader ?? true,
        targetMode: dto.targetMode,
        tableName: dto.tableName,
        schemaName: dto.schemaName,
        conflictMode: dto.conflictMode,
        conflictColumns: dto.conflictColumns,
        columns: dto.columns,
      },
      {
        // Keep the job around briefly after completion so the SSE/poll
        // endpoints can serve final status; clean failed jobs faster so they
        // don't pile up on Redis.
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400, count: 50 },
        attempts: 1,
      },
    );

    // Log that the import was kicked off — the processor also logs completion
    // / failure, but without this entry the Project logs feed has a long gap
    // for any job that takes minutes to finish.
    const fileCount = 1 + extra.length;
    await this.activity.append(projectId, {
      userId: userId || undefined,
      kind: ProjectActivityKind.DATA_IMPORT_STARTED,
      title:
        fileCount === 1
          ? `Data import started → ${dto.tableName}`
          : `Data import started (${fileCount} files) → ${dto.tableName}`,
      detail: `${dto.format.toUpperCase()} · ${dto.filename} → ${dto.schemaName ?? 'public'}.${dto.tableName} (${dto.targetMode}, ${dto.conflictMode})`,
      metadata: {
        jobId: String(job.id),
        targetMode: dto.targetMode,
        conflictMode: dto.conflictMode,
        fileCount,
      },
    });

    return { jobId: String(job.id) };
  }

  /** Status snapshot for poll-based clients. */
  async getJobStatus(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) throw new NotFoundException('Import job not found');
    const state = await job.getState();
    return {
      id: jobId,
      state,
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  /**
   * Best-effort cancellation. BullMQ doesn't preempt a running job; we mark
   * its state via job.moveToFailed so the worker's chunk loop will notice on
   * the next iteration (the worker polls `await job.isFailed()` between
   * batches — see processor).
   */
  async cancelJob(jobId: string, userId: string | undefined): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) throw new NotFoundException('Import job not found');
    if (userId && job.data?.userId && job.data.userId !== userId) {
      throw new NotFoundException('Import job not found');
    }
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') return;
    // moveToFailed with token — using BullMQ's API would require a worker
    // token. Setting a `cancelled` flag in data is simpler and the processor
    // checks for it.
    await job.updateData({ ...job.data, _cancelled: true });
  }

  /**
   * Stream the worker-emitted bad-rows CSV out to the client. Returns null if
   * the job hasn't produced one (no errors, or hasn't finished yet).
   */
  async getErrorReportStream(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) throw new NotFoundException('Import job not found');
    const errorKey = (job.returnvalue as { errorKey?: string } | undefined)?.errorKey;
    if (!errorKey) return null;
    return this.minio.getObject(STAGING_BUCKET, errorKey);
  }

  /** ────── internals ────── */

  private async assertProjectAccess(projectId: string, userId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (userId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!membership) throw new NotFoundException('Project not found');
    }
    return project;
  }

  private async listExistingTables(projectId: string) {
    // Lightweight tables list — the wizard only needs schema + name. We don't
    // pull row counts here to keep inspect snappy on projects with hundreds
    // of tables. The Table Editor still provides counts via its own endpoint.
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) return [];
    const { Pool } = await import('pg');
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 5_000,
    });
    try {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `SELECT schemaname AS schema, tablename AS name
           FROM pg_catalog.pg_tables
           WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
           ORDER BY schemaname, tablename`,
        );
        return r.rows as Array<{ schema: string; name: string }>;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  private async ensureStagingBucket() {
    try {
      const exists = await this.minio.bucketExists(STAGING_BUCKET);
      if (!exists) {
        await this.minio.makeBucket(STAGING_BUCKET, '');
        this.logger.log(`Created MinIO staging bucket: ${STAGING_BUCKET}`);
      }
    } catch (err: any) {
      // BucketAlreadyOwnedByYou: another instance just created it — fine.
      if (err?.code === 'BucketAlreadyOwnedByYou') return;
      throw err;
    }
  }
}

function safeBasename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-128);
}

function mimeForFormat(format: FileFormat): string {
  return format === 'csv'
    ? 'text/csv'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}
