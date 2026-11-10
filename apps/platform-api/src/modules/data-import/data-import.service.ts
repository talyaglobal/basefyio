import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import * as Minio from 'minio';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { DATA_IMPORT_QUEUE } from '../queue/queue.module';
import {
  detectFormat,
  samplePreview,
  DEFAULT_PREVIEW_ROWS,
  ImportFileError,
  MAX_JSON_BYTES,
  type FileFormat,
  type ParsePreview,
} from './lib/file-parser';
import { detectValueFormat, inferSchema } from './lib/type-inferrer';
import type { ImportEncoding } from './lib/text-decoding';
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

const UNSUPPORTED_TYPE = 'Use .csv, .tsv, .txt, .xlsx or .json.';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type InspectEncoding = ImportEncoding | 'auto';

export interface TableShape {
  schema: string;
  columns: Set<string>;
  /** Column sets of the primary key and every plain unique index. */
  uniqueSets: string[][];
}

/**
 * Check an import plan against the target before any job runs, so a mapping
 * mistake is a clear 400 in the wizard instead of a job that dies halfway with
 * a raw Postgres error ("column … does not exist", "no unique or exclusion
 * constraint matching the ON CONFLICT specification"). Pure — the caller
 * supplies the table shape (or null when the table does not exist).
 */
export function validateImportPlan(
  dto: Pick<StartImportDto, 'targetMode' | 'tableName' | 'conflictMode' | 'conflictColumns' | 'columns'>,
  table: TableShape | null,
): string[] {
  const errors: string[] = [];
  if (!IDENT_RE.test(dto.tableName ?? '')) {
    errors.push(
      `"${dto.tableName}" is not a valid table name. Use letters, digits and underscores, starting with a letter or underscore.`,
    );
  }

  const seen = new Map<string, string>();
  for (const c of dto.columns) {
    if (!IDENT_RE.test(c.target ?? '')) {
      errors.push(
        `Target column "${c.target}" (from "${c.source}") is not a valid column name. Use letters, digits and underscores, starting with a letter or underscore.`,
      );
      continue;
    }
    const prev = seen.get(c.target);
    if (prev !== undefined) {
      errors.push(
        `"${prev}" and "${c.source}" are both mapped to column "${c.target}". Each column can take only one source column.`,
      );
    }
    seen.set(c.target, c.source);
  }

  const conflict = dto.conflictColumns ?? [];
  const needsKey = dto.conflictMode === 'skip' || dto.conflictMode === 'update';

  if (dto.targetMode === 'new') {
    if (table) {
      errors.push(
        `Table "${table.schema}"."${dto.tableName}" already exists. Choose "Existing table", or another name.`,
      );
    }
    if (needsKey) {
      for (const c of conflict) {
        if (!seen.has(c)) {
          errors.push(`Conflict column "${c}" is not one of the imported columns.`);
        }
      }
    }
    return errors;
  }

  if (!table) {
    errors.push(`Table "${dto.tableName}" was not found. Pick an existing table, or choose "Create new".`);
    return errors;
  }

  const unknown = dto.columns
    .map((c) => c.target)
    .filter((t) => IDENT_RE.test(t ?? '') && !table.columns.has(t));
  if (unknown.length > 0) {
    errors.push(
      `Column${unknown.length === 1 ? '' : 's'} ${unknown.map((u) => `"${u}"`).join(', ')} ` +
        `${unknown.length === 1 ? 'does' : 'do'} not exist in "${table.schema}"."${dto.tableName}". ` +
        'Map those source columns to an existing column, or leave them out.',
    );
  }

  if (needsKey && conflict.length > 0) {
    const wanted = [...new Set(conflict)].sort().join('\u0000');
    const covered = table.uniqueSets.some((set) => [...set].sort().join('\u0000') === wanted);
    if (!covered) {
      errors.push(
        `"${dto.conflictMode === 'skip' ? 'Skip' : 'Update'}" needs a primary key or unique constraint on exactly ` +
          `(${conflict.join(', ')}) in "${table.schema}"."${dto.tableName}". ` +
          'Pick the primary key as the conflict column, or choose "Fail on conflict".',
      );
    }
    const unmapped = conflict.filter((c) => !seen.has(c));
    if (unmapped.length > 0) {
      errors.push(
        `Conflict column${unmapped.length === 1 ? '' : 's'} ${unmapped.map((u) => `"${u}"`).join(', ')} ` +
          `must also be imported, so rows can be matched.`,
      );
    }
  }
  return errors;
}

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
      throw new BadRequestException(`Unsupported file type: ${filename}. ${UNSUPPORTED_TYPE}`);
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
    encoding: InspectEncoding = 'auto',
  ): Promise<InspectImportResultDto> {
    await this.assertProjectAccess(projectId, userId);

    if (!sourceKey.startsWith(`${projectId}/`)) {
      throw new BadRequestException(
        'sourceKey must belong to the requesting project.',
      );
    }

    const format = detectFormat(filename);
    if (!format) {
      throw new BadRequestException(`Unsupported file type: ${filename}. ${UNSUPPORTED_TYPE}`);
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
    if (format === 'json' && totalSize > MAX_JSON_BYTES) {
      throw new BadRequestException(
        `JSON files are limited to ${Math.round(MAX_JSON_BYTES / 1024 / 1024)} MB. Split the file, or convert it to CSV for larger imports.`,
      );
    }

    // CSV: range-fetch the first 16 MB — enough for 1000 preview rows on
    // any reasonable schema. XLSX and JSON need the whole object to be parsed
    // (zipped / one document) so we fetch it in full. The worker only does
    // this on /inspect, not on every chunk, so the cost is bounded.
    const previewSlice = format === 'csv' ? 16 * 1024 * 1024 : totalSize;
    const buffer = await this.fetchObjectRange(sourceKey, 0, previewSlice);
    const truncated = format === 'csv' && totalSize > previewSlice;

    const preview = this.parsePreview(buffer, format, firstRowIsHeader, {
      encoding,
      truncated,
    });
    const existingTables = await this.listExistingTables(projectId);

    return this.toInspectResult(sourceKey, filename, format, preview, firstRowIsHeader, existingTables, {
      // Approximate based on object size when only the slice was read.
      totalRowsApprox: truncated
        ? Math.round(preview.totalRowsApprox * (totalSize / previewSlice))
        : preview.totalRowsApprox,
    });
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
    /** Character set for CSV/JSON; 'auto' detects it (Windows-1254 when not UTF-8). */
    encoding: InspectEncoding = 'auto',
  ): Promise<InspectImportResultDto> {
    await this.assertProjectAccess(projectId, userId);

    const format = detectFormat(file.originalname, file.mimetype);
    if (!format) {
      throw new BadRequestException(`Unsupported file type: ${file.originalname}. ${UNSUPPORTED_TYPE}`);
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

    const preview = this.parsePreview(file.buffer, format, firstRowIsHeader, { encoding });

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
    return this.toInspectResult(sourceKey, file.originalname, format, preview, firstRowIsHeader, existingTables);
  }

  /** samplePreview with file problems turned into a 400 the wizard can show. */
  private parsePreview(
    buffer: Buffer,
    format: FileFormat,
    firstRowIsHeader: boolean,
    opts: { encoding: InspectEncoding; truncated?: boolean },
  ): ParsePreview {
    let preview: ParsePreview;
    try {
      preview = samplePreview(buffer, format, DEFAULT_PREVIEW_ROWS, firstRowIsHeader, opts);
    } catch (err) {
      if (err instanceof ImportFileError) throw new BadRequestException(err.message);
      throw err;
    }
    if (preview.headers.length === 0) {
      throw new BadRequestException('File has no header row');
    }
    return preview;
  }

  private toInspectResult(
    sourceKey: string,
    filename: string,
    format: FileFormat,
    preview: ParsePreview,
    firstRowIsHeader: boolean,
    existingTables: Array<{ schema: string; name: string }>,
    overrides: { totalRowsApprox?: number } = {},
  ): InspectImportResultDto {
    // Decimal separator and day/month order are read off the sample, so a
    // Turkish file with 1.234,56 and 31.12.1999 infers numeric/date columns.
    const detectedFormat = detectValueFormat(preview.rows);
    const inferred = inferSchema(preview.headers, preview.rows, detectedFormat);
    return {
      sourceKey,
      filename,
      format,
      totalRowsApprox: overrides.totalRowsApprox ?? preview.totalRowsApprox,
      totalRowsExact: overrides.totalRowsApprox === undefined ? preview.totalRowsExact : false,
      encoding: preview.encoding,
      encodingDetected: preview.encodingDetected,
      detectedFormat,
      warnings: preview.warnings,
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
    const project = await this.assertProjectAccess(projectId, userId);

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

    // Check the mapping against the real table now, rather than letting the
    // worker fail on it after the user has walked away.
    const shape = IDENT_RE.test(dto.tableName ?? '')
      ? await this.describeTable(project, dto.tableName, dto.schemaName, dto.targetMode)
      : null;
    const planErrors = validateImportPlan(dto, shape);
    if (planErrors.length > 0) {
      throw new BadRequestException(planErrors.join(' '));
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
        encoding: dto.encoding ?? 'auto',
        valueFormat: dto.valueFormat,
        targetMode: dto.targetMode,
        tableName: dto.tableName,
        schemaName: dto.schemaName ?? (dto.targetMode === 'existing' ? shape?.schema : undefined),
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

  /**
   * Load a job and make sure it belongs to this project and the caller can
   * see the project. Job ids are small sequential numbers, so without this any
   * signed-in user could read another tenant's import status — and download
   * its error report, which carries raw rows.
   */
  private async getAuthorizedJob(projectId: string, userId: string | undefined, jobId: string): Promise<Job> {
    await this.assertProjectAccess(projectId, userId);
    const job = await this.queue.getJob(jobId);
    if (!job || job.data?.projectId !== projectId) {
      throw new NotFoundException('Import job not found');
    }
    return job;
  }

  /** Status snapshot for poll-based clients. */
  async getJobStatus(projectId: string, userId: string | undefined, jobId: string) {
    const job = await this.getAuthorizedJob(projectId, userId, jobId);
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
   * Status for the SSE loop, which already authorized the caller when the
   * stream opened; only the project match is re-checked on each tick.
   */
  async pollJobStatus(projectId: string, jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job || job.data?.projectId !== projectId) {
      throw new NotFoundException('Import job not found');
    }
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
  async cancelJob(projectId: string, jobId: string, userId: string | undefined): Promise<void> {
    const job = await this.getAuthorizedJob(projectId, userId, jobId);
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
  async getErrorReportStream(projectId: string, userId: string | undefined, jobId: string) {
    const job = await this.getAuthorizedJob(projectId, userId, jobId);
    const errorKey = (job.returnvalue as { errorKey?: string } | undefined)?.errorKey;
    if (!errorKey || !errorKey.startsWith(`${projectId}/`)) return null;
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

  private async withProjectClient<T>(
    project: { dbHost: string; dbPort: number; dbUser: string; dbPassword: string; dbName: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const { Pool } = await import('pg');
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 5_000,
      max: 1,
    });
    try {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  /**
   * Columns and unique keys of the import target, or null when it does not
   * exist. Schema resolution matches the worker: an explicit schema, or the
   * one schema that has a table of this name.
   */
  private async describeTable(
    project: { dbHost: string; dbPort: number; dbUser: string; dbPassword: string; dbName: string },
    tableName: string,
    schemaName: string | undefined,
    targetMode: 'existing' | 'new',
  ): Promise<TableShape | null> {
    return this.withProjectClient(project, async (client) => {
      let schema = schemaName;
      if (!schema) {
        if (targetMode === 'new') {
          schema = 'public';
        } else {
          const lookup = await client.query(
            `SELECT schemaname FROM pg_catalog.pg_tables
             WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND tablename = $1`,
            [tableName],
          );
          if ((lookup.rowCount ?? 0) > 1) {
            throw new BadRequestException(
              `Table "${tableName}" exists in more than one schema; pick the schema explicitly.`,
            );
          }
          if (!lookup.rowCount) return null;
          schema = lookup.rows[0].schemaname as string;
        }
      }

      const cols = await client.query(
        `SELECT a.attname AS name
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')
            AND a.attnum > 0 AND NOT a.attisdropped`,
        [schema, tableName],
      );
      if (!cols.rowCount) return null;

      // ON CONFLICT (cols) can only use a non-partial, non-expression unique
      // index whose columns are exactly that set.
      const keys = await client.query(
        `SELECT array_agg(a.attname::text) AS cols
           FROM pg_catalog.pg_index i
           JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
          WHERE n.nspname = $1 AND c.relname = $2
            AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
          GROUP BY i.indexrelid`,
        [schema, tableName],
      );
      return {
        schema,
        columns: new Set(cols.rows.map((r: { name: string }) => r.name)),
        uniqueSets: keys.rows.map((r: { cols: string[] }) => r.cols),
      };
    });
  }

  private async listExistingTables(projectId: string) {
    // Lightweight tables list — the wizard only needs schema + name. We don't
    // pull row counts here to keep inspect snappy on projects with hundreds
    // of tables. The Table Editor still provides counts via its own endpoint.
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) return [];
    return this.withProjectClient(project, async (client) => {
      const r = await client.query(
        `SELECT schemaname AS schema, tablename AS name
         FROM pg_catalog.pg_tables
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schemaname, tablename`,
      );
      return r.rows as Array<{ schema: string; name: string }>;
    });
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
  if (format === 'csv') return 'text/csv';
  if (format === 'json') return 'application/json';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}
