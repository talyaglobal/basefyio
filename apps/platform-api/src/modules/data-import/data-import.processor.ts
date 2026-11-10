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
import { castValue, type InferredType, type ValueFormat } from './lib/type-inferrer';
import type { ImportEncoding } from './lib/text-decoding';

const STAGING_BUCKET = 'bf-platform-data-imports';

/** Hard upper bound on captured bad rows. Keeps the report CSV manageable and
 *  caps memory: bad rows are buffered in-process and uploaded at the end. */
const MAX_BAD_ROWS_CAPTURED = 5_000;

/** How many failed rows travel with the job result so the wizard can list them. */
const BAD_ROWS_SAMPLE = 20;

/**
 * SQLSTATE classes where one row is plausibly to blame, so the batch is
 * retried row by row instead of failing the import:
 *   * 21 (cardinality_violation) — the same key twice in one ON CONFLICT DO
 *     UPDATE batch ("cannot affect row a second time").
 *   * 22 (data_exception) — invalid syntax for type, out of range, …
 *   * 23 (integrity_constraint_violation) — NOT NULL, FK, UNIQUE, CHECK.
 * Other classes (connection loss, undefined column, permission denied) reflect
 * a broken plan, not a bad row, and still fail the job.
 */
const ROW_LOCAL_SQLSTATE_CLASSES = ['21', '22', '23'];

export function isRowLocalError(sqlState: unknown): boolean {
  return (
    typeof sqlState === 'string' &&
    ROW_LOCAL_SQLSTATE_CLASSES.some((cls) => sqlState.startsWith(cls))
  );
}

export interface JobData {
  projectId: string;
  userId?: string;
  sourceKey: string;
  /** Extra staged files to process under the same plan (multi-file import). */
  additionalSourceKeys?: string[];
  filename: string;
  format: FileFormat;
  firstRowIsHeader?: boolean;
  /** Character set of text files; absent or 'auto' detects it per file. */
  encoding?: ImportEncoding | 'auto';
  /** Decimal separator, date order, empty-cell and trim rules for casting. */
  valueFormat?: Partial<ValueFormat>;
  targetMode: 'existing' | 'new';
  tableName: string;
  schemaName?: string;
  conflictMode: 'skip' | 'update' | 'fail';
  conflictColumns?: string[];
  columns: Array<{ source: string; target: string; type: InferredType; nullable?: boolean }>;
  _cancelled?: boolean;
}

export interface JobResult {
  rowsRead: number;
  /** Rows written as new rows. */
  rowsInserted: number;
  /** Rows that replaced an existing row (update mode). */
  rowsUpdated: number;
  rowsSkippedConflict: number;
  /** Every row that failed validation or insert, even beyond the report cap. */
  rowsBad: number;
  errorKey?: string;
  durationMs: number;
  /** The first failed rows, so the wizard can show them without a download. */
  badRowsSample: Array<{ file: number; row: number; reason: string }>;
  /** Plain-language notes (no data rows, report cut short, …). */
  warnings: string[];
}

interface BadRow {
  file: number;
  row: number;
  reason: string;
  raw: unknown[];
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
    let rowsUpdated = 0;
    let rowsSkippedConflict = 0;
    let rowsBad = 0;
    const badRows: BadRow[] = [];
    const recordBad = (row: BadRow) => {
      rowsBad++;
      if (badRows.length < MAX_BAD_ROWS_CAPTURED) badRows.push(row);
    };
    let resolvedSchema = data.schemaName || 'public';
    /** Set once this job has created the target table; a failure then removes it. */
    let createdTable = false;
    // Update mode reports inserted and updated rows separately via RETURNING;
    // flipped off if the target cannot return xmax (e.g. a foreign table).
    const insertState = { countUpdates: data.conflictMode === 'update' };

    try {
      // Resolve schema (existing) or create the table (new).
      const client = await pool.connect();
      try {
        if (data.targetMode === 'new') {
          resolvedSchema = data.schemaName || 'public';
          await this.createTargetTable(
            client,
            resolvedSchema,
            data.tableName,
            data.columns,
            data.conflictMode,
            data.conflictColumns || [],
          );
          createdTable = true;
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

      // Iterate every staged file under the same plan. Schema is taken from
      // the first file; all others must match column-by-column or rows will
      // land in the bad-row report. Progress events carry a file index so the
      // wizard can show "file 3 of 12".
      const allSources = [data.sourceKey, ...(data.additionalSourceKeys ?? [])];
      const totalFiles = allSources.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        const sourceKey = allSources[fileIdx];
        const fileLabel = `${fileIdx + 1}/${totalFiles}`;
        /** Data-row number inside this file (the header is not counted). */
        let fileRow = 0;

        await job.updateProgress({
          step: 'parse',
          detail: `Streaming file ${fileLabel}`,
          rowsRead,
          rowsInserted,
          rowsUpdated,
          fileIndex: fileIdx + 1,
          totalFiles,
          percent: Math.min(95, Math.round(((fileIdx) / totalFiles) * 90) + 5),
        });

        // Re-fetch the buffer per file. For the FIRST file we already loaded
        // it above; we could keep it cached but the simpler shape is one
        // path per file.
        const fileBuffer = fileIdx === 0
          ? buffer
          : await this.fetchSource(sourceKey);

      // Stream rows in WORKER_CHUNK_ROWS-sized batches. Each batch:
      // 1. validate every cell via castValue → split into good rows + bad rows.
      // 2. INSERT good rows in a single parameterized query.
      // 3. update progress.
      // Note: if the request was cancelled, the queue marks data._cancelled = true.
      // We re-read job data each chunk and bail early.
      await streamRows(
        fileBuffer,
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
        const goodRowNumbers: number[] = [];
        for (let i = 0; i < chunk.length; i++) {
          const raw = chunk[i];
          rowsRead++;
          fileRow++;
          const values: unknown[] = [];
          let badReason: string | null = null;

          for (const m of data.columns) {
            const srcIdx = headerIdx.get(m.source);
            const cell = srcIdx !== undefined ? raw[srcIdx] : undefined;
            const r = castValue(cell, m.type, m.nullable ?? true, data.valueFormat);
            if (!r.ok) {
              badReason = `${m.source} → ${m.target} (${m.type}): ${r.reason}`;
              break;
            }
            values.push(r.value);
          }

          if (badReason) {
            recordBad({ file: fileIdx + 1, row: fileRow, reason: badReason, raw: raw as unknown[] });
            continue;
          }
          goodRows.push(values);
          goodRowNumbers.push(fileRow);
        }

        if (goodRows.length > 0) {
          // The fast path: one parameterized INSERT for the whole chunk. When
          // Postgres rejects the batch the entire statement is rolled back,
          // so a row-local error falls back to inserting row by row: the
          // offending rows are isolated as bad rows instead of killing the
          // import. See ROW_LOCAL_SQLSTATE_CLASSES for which errors qualify.
          let inserted = 0;
          let updated = 0;
          let failedInBatch = 0;
          try {
            const r = await this.insertBatch(pool, insertSql, data.columns.length, goodRows, insertState);
            inserted = r.inserted;
            updated = r.updated;
          } catch (err: any) {
            const sqlState: string | undefined = err?.code;
            if (!isRowLocalError(sqlState)) throw err;
            this.logger.warn(
              `Batch insert failed with SQLSTATE ${sqlState} (${err.message}). ` +
                `Retrying ${goodRows.length} rows individually to isolate the bad row(s).`,
            );

            for (let i = 0; i < goodRows.length; i++) {
              const single = goodRows[i];
              try {
                const r = await this.insertBatch(pool, insertSql, data.columns.length, [single], insertState);
                inserted += r.inserted;
                updated += r.updated;
              } catch (rowErr: any) {
                failedInBatch++;
                recordBad({
                  file: fileIdx + 1,
                  row: goodRowNumbers[i],
                  reason: `Database rejected the row (${rowErr?.code ?? '?'}): ${rowErr?.message ?? 'insert failed'}`,
                  raw: single,
                });
              }
            }
          }
          rowsInserted += inserted;
          rowsUpdated += updated;
          // In skip mode, whatever was sent but neither written nor rejected
          // collided with an existing row. Only this batch's failures count.
          if (data.conflictMode === 'skip') {
            rowsSkippedConflict += Math.max(0, goodRows.length - inserted - failedInBatch);
          }
        }

        await job.updateProgress({
          step: 'insert',
          detail: `File ${fileLabel}: processed ${rowsRead.toLocaleString('en-US')} rows`,
          rowsRead,
          rowsInserted,
          rowsUpdated,
          rowsSkipped: rowsSkippedConflict,
          rowsBad,
          fileIndex: fileIdx + 1,
          totalFiles,
          percent: Math.min(
            95,
            Math.round(((fileIdx) / totalFiles) * 90) + 5 +
              Math.floor((rowsRead / Math.max(rowsRead + 1, 100)) * (90 / totalFiles)),
          ),
        });
      }, { firstRowIsHeader: data.firstRowIsHeader ?? true, encoding: data.encoding ?? 'auto' });
      } // end per-file loop

      // Refresh table statistics so the admin-ui sidebar (which reads
      // pg_stat_user_tables.n_live_tup for speed) stops showing a stale
      // pre-import row count. Without this the user sees mismatched numbers:
      // header runs SELECT COUNT(*) and shows the truth (e.g. 1.582.405);
      // sidebar reads n_live_tup and shows whatever autovacuum last sampled
      // (e.g. 1.576.109). ANALYZE is cheap relative to a multi-million row
      // INSERT and runs in O(sample) time, not O(table).
      try {
        const analyzeClient = await pool.connect();
        try {
          await analyzeClient.query(
            `ANALYZE ${quoteIdent(resolvedSchema)}.${quoteIdent(data.tableName)}`,
          );
        } finally {
          analyzeClient.release();
        }
      } catch (err: any) {
        // Non-fatal — n_live_tup will catch up on the next autovacuum cycle
        // anyway, just a bit later.
        this.logger.warn(
          `ANALYZE after import failed for "${resolvedSchema}"."${data.tableName}": ${err.message}`,
        );
      }

      let errorKey: string | undefined;
      if (badRows.length > 0) {
        errorKey = await this.uploadErrorReport(job, data, badRows);
      }

      const warnings: string[] = [];
      if (rowsRead === 0) {
        warnings.push('No data rows were found in the file, so nothing was imported.');
      }
      if (rowsBad > badRows.length) {
        warnings.push(
          `${rowsBad.toLocaleString('en-US')} rows failed; the error report lists the first ${badRows.length.toLocaleString('en-US')}.`,
        );
      }

      const durationMs = Date.now() - started;
      const result: JobResult = {
        rowsRead,
        rowsInserted,
        rowsUpdated,
        rowsSkippedConflict,
        rowsBad,
        errorKey,
        durationMs,
        badRowsSample: badRows.slice(0, BAD_ROWS_SAMPLE).map(({ file, row, reason }) => ({ file, row, reason })),
        warnings,
      };

      // Best-effort cleanup of every staged source file. Failures are
      // tolerated — staging objects expire via MinIO lifecycle anyway.
      for (const key of [data.sourceKey, ...(data.additionalSourceKeys ?? [])]) {
        this.minio.removeObject(STAGING_BUCKET, key).catch(() => undefined);
      }

      await this.activity
        .append(data.projectId, {
          userId: data.userId,
          kind:
            data.targetMode === 'new'
              ? ProjectActivityKind.TABLE_CREATED
              : ProjectActivityKind.TABLE_ROW_INSERTED,
          title: `Data import: ${data.filename}`,
          detail:
            `${rowsInserted.toLocaleString('en-US')} rows inserted` +
            (rowsUpdated ? `, ${rowsUpdated.toLocaleString('en-US')} updated` : '') +
            ` into "${resolvedSchema}"."${data.tableName}" — ${rowsBad.toLocaleString('en-US')} bad rows.`,
        })
        .catch(() => undefined);

      await job.updateProgress({
        step: 'done',
        detail:
          `Inserted ${rowsInserted.toLocaleString('en-US')} rows` +
          (rowsUpdated ? `, updated ${rowsUpdated.toLocaleString('en-US')}` : ''),
        rowsRead,
        rowsInserted,
        rowsUpdated,
        rowsSkipped: rowsSkippedConflict,
        rowsBad,
        percent: 100,
      });

      return result;
    } catch (err: any) {
      // A new table that the import could not fill is removed again — leaving
      // it behind made every retry fail with "Table already exists".
      let message: string = err?.message || 'Import failed';
      if (createdTable) {
        try {
          const dropClient = await pool.connect();
          try {
            await dropClient.query(
              `DROP TABLE IF EXISTS ${quoteIdent(resolvedSchema)}.${quoteIdent(data.tableName)}`,
            );
          } finally {
            dropClient.release();
          }
          message += ' The new table was removed, so you can fix the problem and import again with the same name.';
        } catch (dropErr: any) {
          this.logger.warn(
            `Could not remove "${resolvedSchema}"."${data.tableName}" after a failed import: ${dropErr?.message}`,
          );
        }
      }
      await this.activity
        .append(data.projectId, {
          userId: data.userId,
          kind: ProjectActivityKind.DATA_IMPORT_FAILED,
          title: `Data import failed: ${data.filename}`,
          detail: message.slice(0, 500),
        })
        .catch(() => undefined);
      if (message !== err?.message) {
        const wrapped = new Error(message);
        (wrapped as any).code = err?.code;
        throw wrapped;
      }
      throw err;
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
    conflictMode: JobData['conflictMode'],
    conflictColumns: string[],
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
    await client.query(buildCreateTableSQL(schema, tableName, columns, conflictMode, conflictColumns));
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
                .map((c) => `${quoteIdent(c.target)} = EXCLUDED.${quoteIdent(c.target)}`);
              // Every mapped column is part of the key: nothing to update,
              // so an existing row is left as it is.
              if (updates.length === 0) {
                return ` ON CONFLICT (${conflictColumns.map(quoteIdent).join(', ')}) DO NOTHING`;
              }
              return ` ON CONFLICT (${conflictColumns.map(quoteIdent).join(', ')}) DO UPDATE SET ${updates.join(', ')}`;
            })();
    return `INSERT INTO ${target} (${cols}) VALUES :PLACEHOLDERS:${conflictClause}`;
  }

  private async insertBatch(
    pool: Pool,
    template: string,
    columnCount: number,
    rows: unknown[][],
    state: { countUpdates: boolean },
  ): Promise<{ inserted: number; updated: number }> {
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
      if (state.countUpdates) {
        try {
          // xmax is 0 on a freshly inserted row and set on one that ON
          // CONFLICT DO UPDATE rewrote — the standard way to tell them apart.
          const r = await client.query(`${sql} RETURNING (xmax = 0) AS inserted`, flatParams);
          const inserted = r.rows.filter((row: { inserted: boolean }) => row.inserted === true).length;
          return { inserted, updated: r.rows.length - inserted };
        } catch (err: any) {
          // 42703 undefined column / 0A000 not supported: this target has no
          // xmax (e.g. a foreign table). Count everything as written.
          if (err?.code !== '42703' && err?.code !== '0A000') throw err;
          state.countUpdates = false;
        }
      }
      const r = await client.query(sql, flatParams);
      return { inserted: r.rowCount ?? 0, updated: 0 };
    } finally {
      client.release();
    }
  }

  private async uploadErrorReport(
    job: Job<JobData, JobResult>,
    data: JobData,
    badRows: BadRow[],
  ): Promise<string> {
    const multiFile = (data.additionalSourceKeys?.length ?? 0) > 0;
    const lines: string[] = [];
    lines.push(multiFile ? 'file,source_row,reason,raw_row' : 'source_row,reason,raw_row');
    for (const br of badRows) {
      const raw = csvCell(JSON.stringify(br.raw));
      lines.push(
        `${multiFile ? `${br.file},` : ''}${br.row},${csvCell(br.reason)},${raw}`,
      );
    }
    // UTF-8 with a BOM so Excel shows Turkish characters correctly.
    const body = Buffer.from(`\ufeff${lines.join('\n')}`, 'utf-8');
    const key = `${data.projectId}/${job.id}/errors.csv`;
    await this.minio.putObject(STAGING_BUCKET, key, body, body.length, {
      'Content-Type': 'text/csv; charset=utf-8',
    });
    return key;
  }
}

/**
 * CREATE TABLE for "Create new" imports.
 *
 *   * A mapped column named `id` becomes the primary key. Otherwise a serial
 *     `id` is added — adding it as well used to fail with "column id
 *     specified more than once".
 *   * Skip/update need a unique index matching the conflict columns, so the
 *     new table gets a UNIQUE constraint on them (unless they are the key).
 *   * NOT NULL only where the plan asks for it.
 */
export function buildCreateTableSQL(
  schema: string,
  tableName: string,
  columns: JobData['columns'],
  conflictMode: JobData['conflictMode'],
  conflictColumns: string[],
): string {
  const mappedId = columns.some((c) => c.target === 'id');
  const colDefs = columns.map((c) => {
    const ident = quoteIdent(c.target);
    const pgType = pgTypeFor(c.type);
    if (mappedId && c.target === 'id') return `${ident} ${pgType} PRIMARY KEY`;
    const nullable = c.nullable === false ? ' NOT NULL' : '';
    return `${ident} ${pgType}${nullable}`;
  });
  if (!mappedId) {
    // Matches Table Editor's "New Table" defaults and keeps inserts
    // independent of source data.
    colDefs.unshift(`"id" SERIAL PRIMARY KEY`);
  }
  const keyIsPrimary = conflictColumns.length === 1 && conflictColumns[0] === 'id';
  if ((conflictMode === 'skip' || conflictMode === 'update') && conflictColumns.length > 0 && !keyIsPrimary) {
    colDefs.push(`UNIQUE (${conflictColumns.map(quoteIdent).join(', ')})`);
  }
  return `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(tableName)} (\n  ${colDefs.join(',\n  ')}\n)`;
}

export function quoteIdent(name: string): string {
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
