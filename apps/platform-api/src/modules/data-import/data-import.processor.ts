import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import * as Minio from 'minio';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { DATA_IMPORT_QUEUE } from '../queue/queue.module';
import { streamRows, type FileFormat, WORKER_CHUNK_ROWS } from './lib/file-parser';
import { castValue, type InferredType } from './lib/type-inferrer';

const STAGING_BUCKET = 'kb-platform-data-imports';

/** Hard upper bound on captured bad rows. Keeps the report CSV manageable and
 *  caps memory: bad rows are buffered in-process and uploaded at the end. */
const MAX_BAD_ROWS_CAPTURED = 5_000;

interface JobData {
  projectId: string;
  userId?: string;
  sourceKey: string;
  filename: string;
  format: FileFormat;
  firstRowIsHeader?: boolean;
  targetMode: 'existing' | 'new';
  tableName: string;
  schemaName?: string;
  conflictMode: 'skip' | 'update' | 'fail';
  conflictColumns?: string[];
  columns: Array<{ source: string; target: string; type: InferredType; nullable?: boolean }>;
  _cancelled?: boolean;
}

interface JobResult {
  rowsRead: number;
  rowsInserted: number;
  rowsSkippedConflict: number;
  rowsBad: number;
  errorKey?: string;
  durationMs: number;
}

@Processor(DATA_IMPORT_QUEUE, { concurrency: 1, lockDuration: 5 * 60_000 })
export class DataImportProcessor extends WorkerHost {
  private readonly logger = new Logger(DataImportProcessor.name);
  private readonly minio: Minio.Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly activity: ProjectActivityService,
    @InjectQueue(DATA_IMPORT_QUEUE) private readonly queue: Queue,
  ) {
    super();
    this.minio = new Minio.Client({
      endPoint: this.config.get<string>('minio.endpoint') || 'localhost',
      port: this.config.get<number>('minio.port') || 9000,
      useSSL: this.config.get<boolean>('minio.useSsl') || false,
      accessKey: this.config.get<string>('minio.accessKey') || 'kolaybase',
      secretKey: this.config.get<string>('minio.secretKey') || 'kolaybase_secret',
    });
  }

  async process(job: Job<JobData, JobResult>): Promise<JobResult> {
    const started = Date.now();
    const data = job.data;
    this.logger.log(
      `Import job ${job.id} starting: project=${data.projectId} target=${data.targetMode}:${data.tableName} columns=${data.columns.length}`,
    );

    // Fetch the source file from MinIO into memory. For CSV streaming we keep
    // the whole buffer (papaparse on Node streams accepts only Readable from
    // memory in our setup); for XLSX it's required anyway.
    const buffer = await this.fetchSource(data.sourceKey);

    const project = await this.prisma.project.findFirst({
      where: { id: data.projectId, status: 'ACTIVE' },
    });
    if (!project) throw new Error(`Project ${data.projectId} not found`);

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 60_000,
      max: 4,
    });

    let rowsRead = 0;
    let rowsInserted = 0;
    let rowsSkippedConflict = 0;
    const badRows: Array<{ row: number; reason: string; raw: unknown[] }> = [];
    let resolvedSchema = data.schemaName || 'public';

    try {
      // Resolve schema (existing) or create the table (new).
      const client = await pool.connect();
      try {
        if (data.targetMode === 'new') {
          resolvedSchema = data.schemaName || 'public';
          await this.createTargetTable(client, resolvedSchema, data.tableName, data.columns);
        } else {
          resolvedSchema = await this.resolveSchema(client, data.tableName, data.schemaName);
        }
      } finally {
        client.release();
      }

      await job.updateProgress({
        step: 'parse',
        detail: `Streaming ${data.format.toUpperCase()} file`,
        rowsRead: 0,
        rowsInserted: 0,
        percent: 5,
      });

      const insertSql = this.buildInsertSQL(
        resolvedSchema,
        data.tableName,
        data.columns,
        data.conflictMode,
        data.conflictColumns || [],
      );

      // Stream rows in WORKER_CHUNK_ROWS-sized batches. Each batch:
      // 1. validate every cell via castValue → split into good rows + bad rows.
      // 2. INSERT good rows in a single parameterized query.
      // 3. update progress.
      // Note: if the request was cancelled, the queue marks data._cancelled = true.
      // We re-read job data each chunk and bail early.
      await streamRows(
        buffer,
        data.format,
        async (headers, chunk) => {
        // Refresh cancellation flag.
        const fresh = await job.getState();
        if (fresh === 'failed') throw new Error('Job cancelled');
        const latest = (await this.refreshJobData(job)) as JobData;
        if (latest?._cancelled) throw new Error('Job cancelled');

        // Build a header → index map once per chunk (cheap; headers don't
        // change). This is what aligns the user's column-map to the file.
        const headerIdx = new Map<string, number>();
        headers.forEach((h, i) => headerIdx.set(h, i));

        const goodRows: unknown[][] = [];
        for (let i = 0; i < chunk.length; i++) {
          const raw = chunk[i];
          rowsRead++;
          const values: unknown[] = [];
          let badReason: string | null = null;

          for (const m of data.columns) {
            const srcIdx = headerIdx.get(m.source);
            const cell = srcIdx !== undefined ? raw[srcIdx] : undefined;
            const r = castValue(cell, m.type, m.nullable ?? true);
            if (!r.ok) {
              badReason = `${m.source}/${m.target} (${m.type}): ${r.reason}`;
              break;
            }
            values.push(r.value);
          }

          if (badReason) {
            if (badRows.length < MAX_BAD_ROWS_CAPTURED) {
              badRows.push({ row: rowsRead, reason: badReason, raw: raw as unknown[] });
            }
            continue;
          }
          goodRows.push(values);
        }

        if (goodRows.length > 0) {
          // The fast path: one parameterized INSERT for the whole chunk. When
          // Postgres rejects the batch (NOT NULL, FK, CHECK, …) the entire
          // transaction is rolled back and we lose all 500 rows. Catch that
          // here and fall back to a per-row retry so a single offending row
          // is isolated as a bad-row instead of killing the import.
          //
          // We only fall back on data-integrity errors (Postgres "class 23"
          // SQLSTATE codes: 23502/NOT NULL, 23503/FK, 23505/UNIQUE that we
          // didn't already handle via ON CONFLICT, 23514/CHECK). Other
          // categories (connection loss, syntax errors) still propagate.
          let inserted = 0;
          let attemptedFallback = false;
          try {
            inserted = await this.insertBatch(pool, insertSql, data.columns.length, goodRows);
          } catch (err: any) {
            const sqlState: string | undefined = err?.code;
            const isIntegrityViolation = typeof sqlState === 'string' && sqlState.startsWith('23');
            if (!isIntegrityViolation) throw err;
            attemptedFallback = true;
            this.logger.warn(
              `Batch insert failed with SQLSTATE ${sqlState} (${err.message}). ` +
                `Retrying ${goodRows.length} rows individually to isolate the bad row(s).`,
            );

            // The row indices in `goodRows` are NOT the same as `rowsRead` —
            // `rowsRead` was incremented for ALL chunk rows, including those
            // we filtered out as bad earlier. We approximate the source row
            // number for the report as (rowsRead - goodRows.length + i + 1).
            const batchStartRowNumber = rowsRead - goodRows.length + 1;
            for (let i = 0; i < goodRows.length; i++) {
              const single = goodRows[i];
              try {
                const ins = await this.insertBatch(pool, insertSql, data.columns.length, [single]);
                inserted += ins;
              } catch (rowErr: any) {
                if (badRows.length < MAX_BAD_ROWS_CAPTURED) {
                  badRows.push({
                    row: batchStartRowNumber + i,
                    reason: `DB ${rowErr?.code ?? '?'}: ${rowErr?.message ?? 'insert failed'}`,
                    raw: single,
                  });
                }
              }
            }
          }
          rowsInserted += inserted;
          // Anything we tried to insert but didn't end up in the table must
          // have been a conflict (in skip mode) or an updated row (we count it
          // as inserted for update mode). The difference is meaningful only
          // for skip mode.
          if (data.conflictMode === 'skip') {
            const accountedFor = inserted + (attemptedFallback ? badRows.length : 0);
            rowsSkippedConflict += Math.max(0, goodRows.length - accountedFor);
          }
        }

        await job.updateProgress({
          step: 'insert',
          detail: `Processed ${rowsRead.toLocaleString()} rows`,
          rowsRead,
          rowsInserted,
          rowsSkipped: rowsSkippedConflict,
          rowsBad: badRows.length,
          percent: 5 + Math.min(90, Math.floor((rowsRead / Math.max(rowsRead + 1, 100)) * 90)),
        });
      }, { firstRowIsHeader: data.firstRowIsHeader ?? true });

      let errorKey: string | undefined;
      if (badRows.length > 0) {
        errorKey = await this.uploadErrorReport(job, data, badRows);
      }

      const durationMs = Date.now() - started;
      const result: JobResult = {
        rowsRead,
        rowsInserted,
        rowsSkippedConflict,
        rowsBad: badRows.length,
        errorKey,
        durationMs,
      };

      // Best-effort cleanup of the source file in MinIO. Don't fail the job
      // if cleanup errors — the file expires by lifecycle anyway.
      this.minio.removeObject(STAGING_BUCKET, data.sourceKey).catch(() => undefined);

      await this.activity
        .append(data.projectId, {
          userId: data.userId,
          kind:
            data.targetMode === 'new'
              ? ProjectActivityKind.TABLE_CREATED
              : ProjectActivityKind.TABLE_ROW_INSERTED,
          title: `Data import: ${data.filename}`,
          detail: `${result.rowsInserted.toLocaleString()} rows into "${resolvedSchema}"."${data.tableName}" — ${badRows.length} bad rows.`,
        })
        .catch(() => undefined);

      await job.updateProgress({
        step: 'done',
        detail: `Inserted ${rowsInserted.toLocaleString()} rows`,
        rowsRead,
        rowsInserted,
        rowsSkipped: rowsSkippedConflict,
        rowsBad: badRows.length,
        percent: 100,
      });

      return result;
    } finally {
      await pool.end();
    }
  }

  /** ─────── helpers ─────── */

  private async fetchSource(key: string): Promise<Buffer> {
    const stream = await this.minio.getObject(STAGING_BUCKET, key);
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private async refreshJobData(job: Job<JobData, JobResult>): Promise<JobData | null> {
    try {
      // Re-read job via the injected queue so we see updateData() mutations
      // performed by the cancel endpoint between chunks.
      const refreshed = await this.queue.getJob(job.id!);
      return (refreshed?.data as JobData) || null;
    } catch {
      return null;
    }
  }

  private async resolveSchema(
    client: PoolClient,
    tableName: string,
    schemaName?: string,
  ): Promise<string> {
    if (schemaName) {
      const exists = await client.query(
        `SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = $2`,
        [schemaName, tableName],
      );
      if (exists.rowCount === 0) {
        throw new Error(`Target table "${schemaName}"."${tableName}" not found`);
      }
      return schemaName;
    }
    const lookup = await client.query(
      `SELECT schemaname FROM pg_catalog.pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         AND tablename = $1`,
      [tableName],
    );
    if (lookup.rowCount === 0) throw new Error(`Table "${tableName}" not found`);
    if ((lookup.rowCount ?? 0) > 1) {
      throw new Error(
        `Table "${tableName}" exists in multiple schemas; specify schemaName in the job.`,
      );
    }
    return lookup.rows[0].schemaname;
  }

  private async createTargetTable(
    client: PoolClient,
    schema: string,
    tableName: string,
    columns: JobData['columns'],
  ): Promise<void> {
    // Defensive: refuse to clobber an existing table. The wizard should have
    // already disallowed this on the frontend, but a stale state could slip
    // through.
    const exists = await client.query(
      `SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = $2`,
      [schema, tableName],
    );
    if (exists.rowCount && exists.rowCount > 0) {
      throw new Error(
        `Table "${schema}"."${tableName}" already exists. Pick "existing" mode or choose a new name.`,
      );
    }

    const colDefs = columns.map((c) => {
      const ident = quoteIdent(c.target);
      const pgType = pgTypeFor(c.type);
      const nullable = c.nullable === false ? ' NOT NULL' : '';
      return `${ident} ${pgType}${nullable}`;
    });
    // Always add an `id` SERIAL primary key — matches Table Editor's "New
    // Table" defaults and keeps inserts independent of source data.
    colDefs.unshift(`"id" SERIAL PRIMARY KEY`);
    const sql = `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(tableName)} (\n  ${colDefs.join(',\n  ')}\n)`;
    await client.query(sql);
  }

  private buildInsertSQL(
    schema: string,
    tableName: string,
    columns: JobData['columns'],
    conflictMode: 'skip' | 'update' | 'fail',
    conflictColumns: string[],
  ): string {
    const target = `${quoteIdent(schema)}.${quoteIdent(tableName)}`;
    const cols = columns.map((c) => quoteIdent(c.target)).join(', ');
    // Use a multi-row VALUES with $N placeholders generated per-batch in
    // insertBatch (because batch sizes can vary by leftover-row). Here we
    // emit a template suffix that insertBatch will compose.
    const conflictClause =
      conflictMode === 'fail' || conflictColumns.length === 0
        ? ''
        : conflictMode === 'skip'
          ? ` ON CONFLICT (${conflictColumns.map(quoteIdent).join(', ')}) DO NOTHING`
          : (() => {
              const updates = columns
                .filter((c) => !conflictColumns.includes(c.target))
                .map((c) => `${quoteIdent(c.target)} = EXCLUDED.${quoteIdent(c.target)}`)
                .join(', ');
              return ` ON CONFLICT (${conflictColumns.map(quoteIdent).join(', ')}) DO UPDATE SET ${updates}`;
            })();
    return `INSERT INTO ${target} (${cols}) VALUES :PLACEHOLDERS:${conflictClause}`;
  }

  private async insertBatch(
    pool: Pool,
    template: string,
    columnCount: number,
    rows: unknown[][],
  ): Promise<number> {
    const placeholders = rows
      .map((_, rowIdx) => {
        const params: string[] = [];
        for (let c = 0; c < columnCount; c++) {
          params.push(`$${rowIdx * columnCount + c + 1}`);
        }
        return `(${params.join(', ')})`;
      })
      .join(', ');

    const sql = template.replace(':PLACEHOLDERS:', placeholders);
    const flatParams = rows.flat();

    const client = await pool.connect();
    try {
      const r = await client.query(sql, flatParams);
      return r.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  private async uploadErrorReport(
    job: Job<JobData, JobResult>,
    data: JobData,
    badRows: Array<{ row: number; reason: string; raw: unknown[] }>,
  ): Promise<string> {
    const lines: string[] = [];
    lines.push('source_row,reason,raw_row');
    for (const br of badRows) {
      const raw = csvCell(JSON.stringify(br.raw));
      lines.push(`${br.row},${csvCell(br.reason)},${raw}`);
    }
    const body = Buffer.from(lines.join('\n'), 'utf-8');
    const key = `${data.projectId}/${job.id}/errors.csv`;
    await this.minio.putObject(STAGING_BUCKET, key, body, body.length, {
      'Content-Type': 'text/csv; charset=utf-8',
    });
    return key;
  }
}

function quoteIdent(name: string): string {
  // Defense in depth — caller is expected to have sanitized, but we still
  // refuse identifiers that don't look like Postgres-safe names.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function pgTypeFor(t: InferredType): string {
  switch (t) {
    case 'boolean':
      return 'boolean';
    case 'integer':
      return 'integer';
    case 'bigint':
      return 'bigint';
    case 'numeric':
      return 'numeric';
    case 'uuid':
      return 'uuid';
    case 'date':
      return 'date';
    case 'timestamptz':
      return 'timestamptz';
    case 'jsonb':
      return 'jsonb';
    case 'text':
    default:
      return 'text';
  }
}

function csvCell(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

void WORKER_CHUNK_ROWS;
