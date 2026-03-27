import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { ProjectsService } from './projects.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { StorageService } from '../storage/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IMPORT_QUEUE } from '../queue/queue.module';
import type { ImportJobData } from '../queue/import.processor';

/** Known built-in PostgreSQL base type identifiers (without [] suffix).
 *  Anything NOT in this set is treated as a custom/enum type and falls back
 *  to text / text[] during import so the CREATE TABLE doesn't fail. */
const KNOWN_PG_BASE_TYPES = new Set([
  'uuid', 'text', 'varchar', 'char', 'bpchar', 'name',
  'integer', 'int', 'int2', 'int4', 'int8', 'bigint', 'smallint',
  'serial', 'bigserial', 'smallserial',
  'real', 'float4', 'float8', 'double precision', 'numeric', 'decimal', 'money',
  'boolean', 'bool',
  'bytea', 'bit', 'varbit',
  'json', 'jsonb', 'xml',
  'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval',
  'inet', 'cidr', 'macaddr', 'macaddr8',
  'tsvector', 'tsquery',
  'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle',
  'oid', 'regclass', 'regtype', 'xid', 'cid',
]);

export interface ImportProgress {
  database: { tables: number; rows: number; failedTables: string[] };
  auth: { users: number; skipped: number };
  storage: { buckets: number; objects: number };
  warnings: string[];
}

interface SupabaseColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  udt_name: string;
}

interface SupabaseTable {
  table_name: string;
  table_schema: string;
}

interface SupabaseUser {
  id: string;
  email: string;
  phone: string;
  role: string;
  created_at: string;
  user_metadata?: Record<string, any>;
  email_confirmed_at?: string;
}

interface SupabaseBucket {
  id: string;
  name: string;
  public: boolean;
  created_at: string;
}

interface SupabaseStorageObject {
  name: string;
  id?: string;
  metadata?: { size?: number; mimetype?: string };
}

@Injectable()
export class SupabaseImportService {
  private readonly logger = new Logger(SupabaseImportService.name);
  private readonly cancelledJobs = new Set<string>();

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly projectsService: ProjectsService,
    private readonly keycloak: KeycloakAdminService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    @InjectQueue(IMPORT_QUEUE) private readonly importQueue: Queue,
  ) {}

  isJobCancelled(jobId: string): boolean {
    return this.cancelledJobs.has(jobId);
  }

  private markJobCancelled(jobId: string) {
    this.cancelledJobs.add(jobId);
    setTimeout(() => this.cancelledJobs.delete(jobId), 5 * 60 * 1000);
  }

  /**
   * Enqueue a Supabase import job. Returns immediately with jobId + project.
   */
  async importProject(
    supabaseUrl: string,
    serviceRoleKey: string,
    projectName: string,
    teamId: string,
    userId: string,
    supabaseDatabasePassword?: string,
  ) {
    const baseUrl = supabaseUrl.replace(/\/+$/, '');
    const headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    };

    await this.validateConnection(baseUrl, headers);

    const finalName = projectName || await this.fetchProjectName(baseUrl, headers);

    const project = await this.projectsService.create(
      { name: finalName, teamId },
      userId,
    );

    const jobData: ImportJobData = {
      projectId: project.id,
      projectName: finalName,
      baseUrl,
      serviceRoleKey,
      supabaseDatabasePassword: supabaseDatabasePassword?.trim() || undefined,
      dbHost: project.dbHost,
      dbPort: project.dbPort,
      dbUser: project.dbUser,
      dbPassword: project.dbPassword,
      dbName: project.dbName,
      keycloakRealm: project.keycloakRealm,
    };

    const job = await this.importQueue.add('supabase-import', jobData, {
      attempts: 1,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 7200 },
      // 45-minute hard timeout — prevents the job from hanging indefinitely
      // on slow production networks / Supabase rate limiting.
    });

    this.logger.log(`Import job ${job.id} enqueued for project "${finalName}"`);

    return {
      jobId: job.id,
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
      },
    };
  }

  async fetchProjectName(
    baseUrl: string,
    headers: Record<string, string>,
  ): Promise<string> {
    // Try fetching project name from Supabase auth settings
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${baseUrl}/auth/v1/settings`, {
          headers: { ...headers, Accept: 'application/json' },
          timeout: 10000,
        }),
      );
      // Some Supabase projects expose site_url or external_url with the project name
      const siteUrl: string = data?.SITE_URL || data?.site_url || '';
      if (siteUrl) {
        const host = new URL(siteUrl).hostname;
        if (host && host !== 'localhost' && !host.includes('supabase')) {
          return host.split('.')[0];
        }
      }
    } catch {
      // auth/v1/settings may not be accessible
    }

    // Try decoding the service role JWT to extract the 'ref' field
    try {
      const token = headers['Authorization']?.replace('Bearer ', '') || headers['apikey'];
      if (token) {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        if (payload.ref) {
          return payload.ref;
        }
        // iss is like https://ref.supabase.co/auth/v1
        if (payload.iss) {
          const issHost = new URL(payload.iss).hostname;
          const ref = issHost.split('.')[0];
          if (ref && ref.length < 30) {
            return ref;
          }
        }
      }
    } catch {
      // JWT decode failed
    }

    // Fallback: extract ref from URL hostname
    try {
      const ref = new URL(baseUrl).hostname.split('.')[0];
      return ref || 'imported-project';
    } catch {
      return 'imported-project';
    }
  }

  async validateAndGetInfo(
    supabaseUrl: string,
    serviceRoleKey: string,
  ): Promise<{ valid: boolean; projectName: string; tableCount: number }> {
    const baseUrl = supabaseUrl.replace(/\/+$/, '');
    const headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    };

    await this.validateConnection(baseUrl, headers);
    const openApi = await this.fetchOpenApiSpec(baseUrl, headers);
    const tables = this.extractTablesFromOpenApi(openApi);

    const genericTitles = ['standard public schema', 'postgrest api', 'public', 'postgres'];
    const openApiTitle = openApi?.info?.title?.trim();
    const isGenericTitle = !openApiTitle || genericTitles.includes(openApiTitle.toLowerCase());
    const projectName = isGenericTitle
      ? await this.fetchProjectName(baseUrl, headers)
      : openApiTitle;

    return {
      valid: true,
      projectName,
      tableCount: tables.length,
    };
  }

  async getJobStatus(jobId: string) {
    const job = await this.importQueue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    return {
      id: job.id,
      state,
      progress: job.progress,
      result: state === 'completed' ? job.returnvalue : undefined,
      failedReason: state === 'failed' ? job.failedReason : undefined,
    };
  }

  async cancelImport(jobId: string, userId: string) {
    const job = await this.importQueue.getJob(String(jobId));
    if (!job) throw new Error('Job not found');

    const projectId = (job.data as ImportJobData).projectId;

    this.markJobCancelled(String(jobId));
    this.logger.log(`Marked job ${jobId} as cancelled, waiting for processor to stop...`);

    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
    } else if (state === 'active') {
      // Give the processor up to 3s to notice the cancellation flag and exit
      await new Promise((r) => setTimeout(r, 3000));
      try {
        await job.moveToFailed(new Error('Cancelled by user'), job.token || '0', true);
      } catch {
        // Job may have already finished or been moved
      }
    }

    try {
      await this.projectsService.forceDelete(projectId);
      this.logger.log(`Cancelled import job ${jobId}, project ${projectId} deleted`);
    } catch (err: any) {
      this.logger.warn(`Failed to clean up project ${projectId}: ${err.message}`);
    }

    return { message: 'Import cancelled' };
  }

  // ── Public methods called by ImportProcessor ─────────────

  async runDatabaseImport(
    baseUrl: string,
    headers: Record<string, string>,
    project: any,
    progress: ImportProgress,
    onProgress?: (detail: string, percent: number) => Promise<void>,
  ) {
    await this.importDatabase(baseUrl, headers, project, progress, onProgress);
    await this.importNonPublicSchemaTables(baseUrl, headers, project, progress, onProgress);
  }

  async runAuthImport(
    baseUrl: string,
    headers: Record<string, string>,
    project: any,
    progress: ImportProgress,
    projectName: string,
  ) {
    return this.importAuth(baseUrl, headers, project, progress, projectName);
  }

  async runStorageImport(
    baseUrl: string,
    headers: Record<string, string>,
    project: any,
    progress: ImportProgress,
  ) {
    return this.importStorage(baseUrl, headers, project, progress);
  }

  // ── Private: Connection ─────────────────────────────────

  /** Reject anon key early — PostgREST will list OpenAPI but table rows return 403 on RLS-heavy projects. */
  private assertServiceRoleKey(serviceRoleKey: string) {
    const key = serviceRoleKey?.trim();
    if (!key) return;
    try {
      const parts = key.split('.');
      if (parts.length < 2) return;
      const json = Buffer.from(parts[1], 'base64').toString('utf8');
      const payload = JSON.parse(json) as { role?: string };
      if (payload.role === 'anon') {
        throw new BadRequestException(
          'This is the anon (public) API key. Use the service_role secret from Supabase → Settings → API for a full import.',
        );
      }
      if (payload.role && payload.role !== 'service_role') {
        this.logger.warn(
          `API key JWT role is "${payload.role}"; use service_role for reliable table reads.`,
        );
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
    }
  }

  private async validateConnection(
    baseUrl: string,
    headers: Record<string, string>,
  ) {
    const bearer = headers['Authorization']?.replace(/^Bearer\s+/i, '').trim();
    const apikey = headers['apikey']?.trim();
    this.assertServiceRoleKey(bearer || apikey || '');

    try {
      await firstValueFrom(
        this.http.get(`${baseUrl}/rest/v1/`, {
          headers: { ...headers, Accept: 'application/json' },
          timeout: 60000,
        }),
      );
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        throw new BadRequestException(
          'Invalid Supabase credentials. Make sure you are using the service_role key.',
        );
      }
      throw new BadRequestException(
        `Cannot connect to Supabase at ${baseUrl}: ${err.message}`,
      );
    }
  }

  // ── OpenAPI Spec ────────────────────────────────────────

  private async fetchOpenApiSpec(
    baseUrl: string,
    headers: Record<string, string>,
  ): Promise<any> {
    const { data } = await firstValueFrom(
      this.http.get(`${baseUrl}/rest/v1/`, {
        headers: { ...headers, Accept: 'application/openapi+json' },
        timeout: 30000,
      }),
    );
    return data;
  }

  private extractTablesFromOpenApi(openApi: any): SupabaseTable[] {
    const paths = openApi?.paths || {};
    const tables: SupabaseTable[] = [];
    const views: string[] = [];

    for (const path of Object.keys(paths)) {
      const tableName = path.replace(/^\//, '');
      if (!tableName || tableName.startsWith('rpc/')) continue;

      const methods = paths[path] || {};
      const hasPost = !!methods.post;

      if (hasPost) {
        tables.push({ table_name: tableName, table_schema: 'public' });
      } else {
        views.push(tableName);
      }
    }

    if (views.length > 0) {
      this.logger.log(
        `Skipping ${views.length} views/materialized views: ${views.slice(0, 10).join(', ')}${views.length > 10 ? '...' : ''}`,
      );
    }

    return tables;
  }

  private extractColumnsFromOpenApi(
    openApi: any,
    tableName: string,
  ): SupabaseColumn[] {
    const definitions = openApi?.definitions || {};
    const tableSchema = definitions[tableName];

    if (!tableSchema?.properties) {
      throw new Error(`No schema found for table "${tableName}"`);
    }

    const requiredCols: string[] = tableSchema.required || [];
    const columns: SupabaseColumn[] = [];

    for (const [colName, colSpec] of Object.entries<any>(
      tableSchema.properties,
    )) {
      columns.push({
        column_name: colName,
        data_type: this.openApiTypeToPg(colSpec),
        is_nullable: requiredCols.includes(colName) ? 'NO' : 'YES',
        column_default: colSpec.default ?? null,
        character_maximum_length: colSpec.maxLength ?? null,
        udt_name: colSpec.format || colSpec.type || 'text',
      });
    }

    return columns;
  }

  // ── Database Import ───────────────────────────────────

  /** Project ref for db.<ref>.supabase.co — from hostname or JWT payload. */
  private resolveSupabaseProjectRef(
    baseUrl: string,
    serviceRoleKey: string,
  ): string | null {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      const m = host.match(/^([a-z0-9]{15,})\.supabase\.co$/);
      if (m) return m[1];
    } catch {
      // ignore
    }
    try {
      const parts = serviceRoleKey.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64').toString('utf8'),
        );
        if (payload.ref && typeof payload.ref === 'string') return payload.ref;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async connectPoolWithRetry(pool: Pool, label: string, maxRetries = 5): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const client = await pool.connect();
        client.release();
        this.logger.log(`DB pool "${label}" connected (attempt ${attempt})`);
        return;
      } catch (err: any) {
        this.logger.warn(
          `DB pool "${label}" connect attempt ${attempt}/${maxRetries} failed: ${err.message}`,
        );
        if (attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }

  private async importDatabase(
    baseUrl: string,
    headers: Record<string, string>,
    project: any,
    progress: ImportProgress,
    onProgress?: (detail: string, percent: number) => Promise<void>,
  ) {
    const openApi = await this.fetchOpenApiSpec(baseUrl, headers);
    const tables = this.extractTablesFromOpenApi(openApi);

    this.logger.log(`Found ${tables.length} tables to import`);

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
    });

    await this.connectPoolWithRetry(pool, project.dbName);

    let sourcePool: Pool | null = null;
    const pwd: string | undefined = project.supabaseDatabasePassword;
    const jwt = headers['Authorization']?.replace(/^Bearer\s+/i, '') || headers['apikey'];
    if (pwd) {
      const ref = this.resolveSupabaseProjectRef(baseUrl, jwt || '');
      if (ref) {
        try {
          sourcePool = new Pool({
            host: `db.${ref}.supabase.co`,
            port: 5432,
            user: 'postgres',
            password: pwd,
            database: 'postgres',
            ssl: { rejectUnauthorized: false },
            max: 3,
          });
          await this.connectPoolWithRetry(sourcePool, `supabase-remote-${ref}`);
          this.logger.log(
            `Direct Postgres copy enabled (db.${ref}.supabase.co) — bypasses PostgREST row-level grants`,
          );
        } catch (err: any) {
          this.logger.warn(
            `Direct Postgres connection failed (${err.message}); falling back to PostgREST for data`,
          );
          if (sourcePool) {
            await sourcePool.end().catch(() => {});
            sourcePool = null;
          }
        }
      } else {
        this.logger.warn(
          'databasePassword was set but project ref could not be resolved; using PostgREST only',
        );
      }
    }

    try {
      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        const pct = 5 + Math.round((i / tables.length) * 45);

        try {
          if (onProgress) {
            await onProgress(`Creating table "${table.table_name}" (${i + 1}/${tables.length})`, pct);
          }

          const columns = this.extractColumnsFromOpenApi(
            openApi,
            table.table_name,
          );

          await this.createLocalTable(pool, table.table_name, columns);
          progress.database.tables++;

          if (onProgress) {
            await onProgress(`Importing data for "${table.table_name}" (${i + 1}/${tables.length})`, pct);
          }

          const rowCount = sourcePool
            ? await this.copyTableDataFromDirectPostgres(
                sourcePool,
                pool,
                table.table_name,
                columns,
              )
            : await this.copyTableDataFromRest(
                baseUrl,
                headers,
                pool,
                table.table_name,
                columns,
              );
          progress.database.rows += rowCount;

          this.logger.log(
            `Table "${table.table_name}": schema OK, ${rowCount} rows imported`,
          );
        } catch (err: any) {
          this.logger.error(
            `Failed to import table "${table.table_name}": ${err.message}`,
            err.stack,
          );
          progress.database.failedTables.push(table.table_name);
          progress.warnings.push(
            `Table "${table.table_name}": ${err.message}`,
          );
        }
      }
    } finally {
      await pool.end();
      if (sourcePool) await sourcePool.end().catch(() => {});
    }
  }

  // ── Non-public Schema Import (e.g. supabase_migrations) ─────────────────

  /**
   * Supabase keeps migration history in the `supabase_migrations` schema,
   * which PostgREST does NOT expose via the standard OpenAPI spec.
   * We try to access it with the `Accept-Profile` header and import any
   * rows we can read into corresponding tables in the local project DB.
   */
  private async importNonPublicSchemaTables(
    baseUrl: string,
    headers: Record<string, string>,
    project: any,
    progress: ImportProgress,
    onProgress?: (detail: string, percent: number) => Promise<void>,
  ) {
    // Well-known non-public tables that Supabase may expose via Accept-Profile
    const extraTables: Array<{ schema: string; table: string }> = [
      { schema: 'supabase_migrations', table: 'schema_migrations' },
    ];

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
    });

    await this.connectPoolWithRetry(pool, `${project.dbName}-migrations`);

    try {
      for (const { schema, table } of extraTables) {
        try {
          if (onProgress) {
            await onProgress(`Trying to import "${schema}.${table}"…`, 48);
          }

          // Use Accept-Profile to request a non-public schema from PostgREST
          const response = await firstValueFrom(
            this.http.get(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`, {
              headers: {
                ...headers,
                'Accept-Profile': schema,
                Accept: 'application/json',
              },
              params: { select: '*', limit: 1000, offset: 0 },
              timeout: 30000,
            }),
          );

          const rows: any[] = Array.isArray(response.data) ? response.data : [];
          if (rows.length === 0) {
            this.logger.log(
              `Non-public table "${schema}.${table}": accessible but empty — skipping`,
            );
            continue;
          }

          // Infer column definitions from the first row
          const firstRow = rows[0];
          const columns: SupabaseColumn[] = Object.keys(firstRow).map((col) => {
            const val = firstRow[col];
            let pgType = 'text';
            if (typeof val === 'number')
              pgType = Number.isInteger(val) ? 'bigint' : 'double precision';
            else if (typeof val === 'boolean') pgType = 'boolean';
            else if (Array.isArray(val)) pgType = 'text[]';
            return {
              column_name: col,
              data_type: pgType,
              is_nullable: 'YES',
              column_default: null,
              character_maximum_length: null,
              udt_name: pgType,
            };
          });

          // Build typeMap so insertSingleRow handles arrays/json properly
          const typeMap: Record<string, string> = {};
          for (const col of columns) {
            typeMap[col.column_name.replace(/[^a-zA-Z0-9_]/g, '')] = col.data_type;
          }

          await this.createLocalTable(pool, table, columns);

          // Paginate and import all rows
          let totalRows = rows.length;
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            for (const row of rows) {
              const keys = Object.keys(row);
              if (keys.length) {
                await this.insertSingleRow(client, table, keys, row, typeMap);
              }
            }
            await client.query('COMMIT');
          } catch (err: any) {
            await client.query('ROLLBACK').catch(() => {});
            this.logger.warn(
              `Batch insert failed for "${schema}.${table}": ${err.message}`,
            );
            progress.warnings.push(
              `Non-public "${schema}.${table}" batch insert failed: ${err.message}`,
            );
          } finally {
            client.release();
          }

          // Fetch additional pages if more than 1000 rows
          let offset = 1000;
          while (rows.length === 1000) {
            try {
              const nextResp = await firstValueFrom(
                this.http.get(
                  `${baseUrl}/rest/v1/${encodeURIComponent(table)}`,
                  {
                    headers: {
                      ...headers,
                      'Accept-Profile': schema,
                      Accept: 'application/json',
                    },
                    params: { select: '*', limit: 1000, offset },
                    timeout: 30000,
                  },
                ),
              );
              const nextRows: any[] = Array.isArray(nextResp.data)
                ? nextResp.data
                : [];
              if (nextRows.length === 0) break;

              const nextClient = await pool.connect();
              try {
                await nextClient.query('BEGIN');
                for (const row of nextRows) {
                  const keys = Object.keys(row);
                  if (keys.length)
                    await this.insertSingleRow(nextClient, table, keys, row, typeMap);
                }
                await nextClient.query('COMMIT');
                totalRows += nextRows.length;
              } catch (pageErr: any) {
                await nextClient.query('ROLLBACK').catch(() => {});
                progress.warnings.push(
                  `Non-public "${schema}.${table}" page at offset ${offset} failed: ${pageErr?.message || 'unknown error'}`,
                );
              } finally {
                nextClient.release();
              }

              if (nextRows.length < 1000) break;
              offset += 1000;
            } catch (pageHttpErr: any) {
              progress.warnings.push(
                `Non-public "${schema}.${table}" could not fetch page at offset ${offset}: ${pageHttpErr?.message || 'unknown error'}`,
              );
              break;
            }
          }

          progress.database.tables++;
          progress.database.rows += totalRows;
          this.logger.log(
            `Imported "${schema}.${table}": ${totalRows} rows`,
          );
        } catch (err: any) {
          // Non-public schemas are often blocked — log and continue gracefully
          const status = err.response?.status;
          if (status === 404 || status === 400 || status === 403) {
            this.logger.log(
              `Non-public table "${schema}.${table}" not accessible via PostgREST (${status}) — skipping`,
            );
            progress.warnings.push(
              `Non-public "${schema}.${table}" not imported (API returned ${status}).`,
            );
          } else {
            this.logger.warn(
              `Could not import "${schema}.${table}": ${err.message}`,
            );
            progress.warnings.push(
              `Non-public "${schema}.${table}": ${err.message}`,
            );
          }
        }
      }
    } finally {
      await pool.end();
    }
  }

  private openApiTypeToPg(spec: any): string {
    const format = (spec.format || '').toLowerCase();
    const type = (spec.type || '').toLowerCase();
    const description = (spec.description || '').toLowerCase();

    if (format === 'uuid') return 'uuid';
    if (format === 'timestamp with time zone' || format === 'timestamptz')
      return 'timestamptz';
    if (format === 'timestamp without time zone' || format === 'timestamp')
      return 'timestamp';
    if (format === 'date') return 'date';
    if (format === 'time with time zone' || format === 'timetz') return 'timetz';
    if (format === 'time without time zone' || format === 'time') return 'time';
    if (format === 'interval') return 'interval';
    if (format === 'bigint' || format === 'int8') return 'bigint';
    if (format === 'integer' || format === 'int4') return 'integer';
    if (format === 'smallint' || format === 'int2') return 'smallint';
    if (format === 'real' || format === 'float4') return 'real';
    if (format === 'double precision' || format === 'float8')
      return 'double precision';
    if (format === 'numeric' || format === 'decimal') return 'numeric';
    if (format === 'money') return 'numeric';
    if (format === 'boolean' || format === 'bool') return 'boolean';
    if (format === 'jsonb') return 'jsonb';
    if (format === 'json') return 'json';
    if (format === 'bytea') return 'bytea';
    if (format === 'inet') return 'inet';
    if (format === 'cidr') return 'cidr';
    if (format === 'macaddr') return 'macaddr';
    if (format === 'tsvector') return 'tsvector';
    if (format === 'tsquery') return 'tsquery';
    if (format === 'point') return 'point';
    if (format === 'line') return 'line';
    if (format === 'lseg') return 'lseg';
    if (format === 'box') return 'box';
    if (format === 'path') return 'path';
    if (format === 'polygon') return 'polygon';
    if (format === 'circle') return 'circle';

    if (format.endsWith('[]')) {
      const base = format.slice(0, -2);
      // Schema-qualified (e.g. "public.segment_type[]") or unknown custom enum
      // arrays cannot be recreated in the target DB — map them to text[]
      if (base.includes('.') || !KNOWN_PG_BASE_TYPES.has(base)) return 'text[]';
      return format;
    }
    if (format.startsWith('_')) {
      const base = format.slice(1);
      // Internal pg array names (e.g. "_int4" → "int4[]").
      // Custom enum internal names (e.g. "_segment_type") → text[]
      if (base.includes('.') || !KNOWN_PG_BASE_TYPES.has(base)) return 'text[]';
      return base + '[]';
    }

    if (type === 'array') {
      if (spec.items) {
        const itemFormat = (spec.items.format || '').toLowerCase();
        const itemType = (spec.items.type || '').toLowerCase();
        if (itemFormat === 'uuid') return 'uuid[]';
        if (itemFormat === 'integer' || itemFormat === 'int4') return 'integer[]';
        if (itemFormat === 'bigint' || itemFormat === 'int8') return 'bigint[]';
        if (itemFormat === 'smallint' || itemFormat === 'int2') return 'smallint[]';
        if (itemFormat === 'boolean' || itemFormat === 'bool') return 'boolean[]';
        if (itemFormat === 'numeric' || itemFormat === 'decimal') return 'numeric[]';
        if (itemFormat === 'real' || itemFormat === 'float4') return 'real[]';
        if (itemFormat === 'double precision' || itemFormat === 'float8') return 'double precision[]';
        if (itemFormat === 'jsonb') return 'jsonb[]';
        if (itemFormat === 'json') return 'json[]';
        if (itemType === 'integer') return 'integer[]';
        if (itemType === 'number') return 'numeric[]';
        if (itemType === 'boolean') return 'boolean[]';
        if (itemType === 'string') return 'text[]';
        // Custom enum arrays (e.g. items.$ref to a custom type) → text[]
        if (itemFormat && itemFormat !== 'text') return 'text[]';
      }
      return 'text[]';
    }

    if (type === 'integer') return 'integer';
    if (type === 'number') return 'numeric';
    if (type === 'boolean') return 'boolean';
    if (type === 'object') return 'jsonb';

    if (description.includes('primary key')) return 'bigint';

    if (spec.maxLength) return `varchar(${spec.maxLength})`;

    return 'text';
  }

  private async createLocalTable(
    pool: Pool,
    tableName: string,
    columns: SupabaseColumn[],
  ) {
    const sanitized = tableName.replace(/[^a-zA-Z0-9_]/g, '');

    const colDefs = columns.map((col) => {
      const colName = col.column_name.replace(/[^a-zA-Z0-9_]/g, '');
      let def = `"${colName}" ${col.data_type}`;
      if (col.column_default !== null && col.column_default !== undefined) {
        const safe = String(col.column_default);
        if (
          /^(gen_random_uuid\(\)|uuid_generate_v4\(\)|now\(\)|true|false|CURRENT_TIMESTAMP|nextval\(|'[^']*'::|-?\d+(\.\d+)?$)/.test(
            safe,
          )
        ) {
          def += ` DEFAULT ${safe}`;
        }
      }
      return def;
    });

    const client = await pool.connect();
    try {
      await client.query(`DROP TABLE IF EXISTS "${sanitized}" CASCADE`);
      const sql = `CREATE TABLE "${sanitized}" (\n  ${colDefs.join(',\n  ')}\n)`;
      await client.query(sql);
      this.logger.log(`Created table "${sanitized}" (${columns.length} columns)`);
    } finally {
      client.release();
    }
  }

  /**
   * Paginated row fetch via official Supabase client (same PostgREST, correct headers / encoding).
   */
  private async fetchPageViaSupabaseClient(
    sb: SupabaseClient,
    tableName: string,
    offset: number,
    pageSize: number,
    retries = 3,
  ): Promise<any[] | null | undefined> {
    const rangeEnd = offset + pageSize - 1;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const { data, error } = await sb
          .from(tableName)
          .select('*')
          .range(offset, rangeEnd);

        if (error) {
          const low = (error.message || '').toLowerCase();
          const st = (error as { statusCode?: number; status?: number }).statusCode
            ?? (error as { status?: number }).status;
          if (low.includes('range not satisfiable') || low.includes('416') || st === 416) {
            return null;
          }
          if (
            st === 403 ||
            st === 401 ||
            low.includes('permission denied') ||
            error.code === '42501' ||
            low.includes('jwt expired') ||
            low.includes('invalid jwt')
          ) {
            this.logger.warn(
              `Access denied "${tableName}" offset=${offset}: ${error.message?.slice(0, 180)} — ` +
                `confirm service_role key; if tables still fail, add Database password for direct Postgres copy.`,
            );
            return null;
          }
          this.logger.warn(
            `fetchPage "${tableName}" offset=${offset} attempt ${attempt}/${retries}: ${error.message}`,
          );
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, attempt * 2000));
            continue;
          }
          return undefined;
        }

        const rows = Array.isArray(data) ? data : [];
        if (offset === 0 && attempt === 1) {
          this.logger.log(
            `fetchPage "${tableName}" offset=0: got ${rows.length} items (supabase-js)`,
          );
        }
        return rows;
      } catch (err: any) {
        this.logger.warn(
          `Fetch "${tableName}" offset=${offset} attempt ${attempt}/${retries}: ${err.message}`,
        );
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }
    this.logger.warn(`fetchPage "${tableName}" offset=${offset}: all ${retries} retries exhausted`);
    return undefined;
  }

  /**
   * Read rows via direct connection to Supabase Postgres (postgres role).
   * Use when PostgREST returns 403 because service_role lacks SELECT on a table.
   */
  private async copyTableDataFromDirectPostgres(
    sourcePool: Pool,
    destPool: Pool,
    tableName: string,
    columns: SupabaseColumn[],
  ): Promise<number> {
    const sanitized = tableName.replace(/[^a-zA-Z0-9_]/g, '');
    const columnNames = columns.map((c) =>
      c.column_name.replace(/[^a-zA-Z0-9_]/g, ''),
    );
    const colList = columnNames.map((n) => `"${n}"`).join(', ');
    const typeMap: Record<string, string> = {};
    for (const col of columns) {
      const cleanName = col.column_name.replace(/[^a-zA-Z0-9_]/g, '');
      typeMap[cleanName] = col.data_type;
    }
    const knownCols = new Set(columnNames);
    let totalRows = 0;
    let offset = 0;
    const pageSize = 2000;
    let firstPageLogged = false;

    while (true) {
      const src = await sourcePool.connect();
      let rows: any[];
      try {
        const res = await src.query(
          `SELECT ${colList} FROM public."${sanitized}" ORDER BY ctid LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );
        rows = res.rows;
      } catch (err: any) {
        this.logger.warn(
          `Direct PG SELECT failed for "${sanitized}" offset=${offset}: ${err.message}`,
        );
        if (offset === 0) return 0;
        break;
      } finally {
        src.release();
      }

      if (!rows.length) break;

      if (!firstPageLogged) {
        const sampleRow = rows[0];
        const rowKeys = Object.keys(sampleRow);
        const matched = rowKeys.filter((k) => knownCols.has(k));
        this.logger.log(
          `"${sanitized}" direct PG first page: ${rows.length} rows, matched cols=${matched.length}/${columnNames.length}`,
        );
        firstPageLogged = true;
      }

      const client = await destPool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const rowKeys = Object.keys(row);
          if (!rowKeys.length) continue;
          await this.insertSingleRow(client, sanitized, rowKeys, row, typeMap, knownCols);
        }
        await client.query('COMMIT');
        totalRows += rows.length;
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        this.logger.warn(
          `Batch insert failed for "${sanitized}" (direct PG path) at offset ${offset}: ${err.message}`,
        );
        const retryClient = await destPool.connect();
        try {
          let savedRows = 0;
          for (const row of rows) {
            try {
              const rowKeys = Object.keys(row);
              if (!rowKeys.length) continue;
              await this.insertSingleRow(retryClient, sanitized, rowKeys, row, typeMap, knownCols);
              savedRows++;
            } catch {
              // skip bad row
            }
          }
          totalRows += savedRows;
        } finally {
          retryClient.release();
        }
        if (rows.length < pageSize) break;
        offset += pageSize;
        continue;
      } finally {
        client.release();
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    if (totalRows === 0) {
      this.logger.warn(`Table "${sanitized}": 0 rows via direct PG — check table exists in public schema`);
    } else {
      this.logger.log(`Imported ${totalRows} rows into "${sanitized}" (direct PG)`);
    }
    return totalRows;
  }

  private async copyTableDataFromRest(
    baseUrl: string,
    headers: Record<string, string>,
    pool: Pool,
    tableName: string,
    columns: SupabaseColumn[],
  ): Promise<number> {
    const serviceKey =
      headers['Authorization']?.replace(/^Bearer\s+/i, '').trim() ||
      headers['apikey']?.trim() ||
      '';
    const sb = createClient(baseUrl.replace(/\/+$/, ''), serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' },
    });

    const sanitized = tableName.replace(/[^a-zA-Z0-9_]/g, '');
    const columnNames = columns.map((c) =>
      c.column_name.replace(/[^a-zA-Z0-9_]/g, ''),
    );
    const typeMap: Record<string, string> = {};
    for (const col of columns) {
      const cleanName = col.column_name.replace(/[^a-zA-Z0-9_]/g, '');
      typeMap[cleanName] = col.data_type;
    }
    const knownCols = new Set(columnNames);
    let totalRows = 0;
    let offset = 0;
    const pageSize = 1000;
    let firstPageLogged = false;

    while (true) {
      const rows = await this.fetchPageViaSupabaseClient(sb, tableName, offset, pageSize);

      if (rows === null) break;
      if (rows === undefined) {
        this.logger.warn(`Skipping remaining pages of "${tableName}" after fetch failures`);
        break;
      }
      if (!Array.isArray(rows) || rows.length === 0) break;

      if (!firstPageLogged) {
        const sampleRow = rows[0];
        const rowKeys = Object.keys(sampleRow);
        const matched = rowKeys.filter((k) => knownCols.has(k));
        const extra = rowKeys.filter((k) => !knownCols.has(k));
        this.logger.log(
          `"${tableName}" first page: ${rows.length} rows, ` +
          `schema cols=${columnNames.length}, ` +
          `row keys=${rowKeys.length}, ` +
          `matched=${matched.length}` +
          (extra.length > 0 ? `, extra keys=[${extra.join(',')}]` : ''),
        );
        firstPageLogged = true;
      }

      const client = await pool.connect();
      let batchSucceeded = false;
      try {
        await client.query('BEGIN');

        for (const row of rows) {
          const rowKeys = Object.keys(row);
          if (!rowKeys.length) continue;
          await this.insertSingleRow(client, sanitized, rowKeys, row, typeMap, knownCols);
        }

        await client.query('COMMIT');
        batchSucceeded = true;
        totalRows += rows.length;
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});

        this.logger.warn(
          `Batch insert failed for "${sanitized}" at offset ${offset}: ${err.message}`,
        );

        const retryClient = await pool.connect();
        let savedRows = 0;
        let failCount = 0;
        try {
          for (const row of rows) {
            try {
              const rowKeys = Object.keys(row);
              if (!rowKeys.length) continue;
              await this.insertSingleRow(retryClient, sanitized, rowKeys, row, typeMap, knownCols);
              savedRows++;
            } catch (rowErr: any) {
              failCount++;
              if (failCount <= 3) {
                this.logger.warn(
                  `Row insert failed in "${sanitized}": ${rowErr.message} | row keys: ${Object.keys(row).join(',')}`,
                );
              }
            }
          }
          if (failCount > 3) {
            this.logger.warn(`"${sanitized}": ${failCount} rows failed in batch at offset ${offset} (showing first 3)`);
          }
          totalRows += savedRows;
        } finally {
          retryClient.release();
        }

        if (rows.length < pageSize) { client.release(); break; }
        offset += pageSize;
        client.release();
        continue;
      } finally {
        if (batchSucceeded) {
          try { client.release(); } catch {}
        }
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    if (totalRows === 0) {
      this.logger.warn(`Table "${sanitized}": 0 rows imported — data may be missing`);
    } else {
      this.logger.log(`Imported ${totalRows} rows into "${sanitized}"`);
    }
    return totalRows;
  }

  private async insertSingleRow(
    client: any,
    tableName: string,
    keys: string[],
    row: Record<string, any>,
    typeMap: Record<string, string>,
    knownColumns?: Set<string>,
  ) {
    const filteredKeys = knownColumns
      ? keys.filter((k) => knownColumns.has(k.replace(/[^a-zA-Z0-9_]/g, '')))
      : keys;
    if (!filteredKeys.length) return;

    const cleanKeys = filteredKeys.map((k) => k.replace(/[^a-zA-Z0-9_]/g, ''));
    const cols = cleanKeys.map((k) => `"${k}"`).join(', ');
    const placeholders = cleanKeys.map((_, i) => `$${i + 1}`).join(', ');
    const values = filteredKeys.map((k, i) => {
      const v = row[k];
      if (v === null || v === undefined) return null;

      const pgType = (typeMap[cleanKeys[i]] || '').toLowerCase();

      if (pgType.endsWith('[]') || pgType.startsWith('_')) {
        if (Array.isArray(v)) {
          return this.jsonArrayToPgArray(v);
        }
        if (typeof v === 'string') {
          if (v.startsWith('{') && v.endsWith('}')) return v;
          try {
            const parsed = JSON.parse(v);
            if (Array.isArray(parsed)) return this.jsonArrayToPgArray(parsed);
          } catch {}
          return v;
        }
      }

      if (pgType === 'json' || pgType === 'jsonb') {
        if (typeof v === 'string') {
          try {
            JSON.parse(v);
            return v;
          } catch {
            return JSON.stringify(v);
          }
        }
        return JSON.stringify(v);
      }

      if (typeof v === 'object' && !Array.isArray(v)) {
        return JSON.stringify(v);
      }

      if (Array.isArray(v)) {
        return JSON.stringify(v);
      }

      return v;
    });

    await client.query(
      `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private jsonArrayToPgArray(arr: any[]): string {
    const elements = arr.map((item) => {
      if (item === null || item === undefined) return 'NULL';
      const str = String(item);
      const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    });
    return `{${elements.join(',')}}`;
  }

  // ── Auth Import ───────────────────────────────────────

  private generateReadablePassword(): string {
    return `Kb-${randomBytes(6).toString('base64url').slice(0, 10)}`;
  }

  private async importAuth(
    baseUrl: string,
    headers: Record<string, string>,
    project: any,
    progress: ImportProgress,
    projectName: string,
  ) {
    let allUsers: SupabaseUser[] = [];
    let page = 1;
    const perPage = 500;

    while (true) {
      try {
        const { data } = await firstValueFrom(
          this.http.get(`${baseUrl}/auth/v1/admin/users`, {
            headers,
            params: { page, per_page: perPage },
            timeout: 30000,
          }),
        );
        const users: SupabaseUser[] = data?.users || data || [];
        if (!Array.isArray(users) || users.length === 0) break;
        allUsers.push(...users);
        if (users.length < perPage) break;
        page++;
      } catch (err: any) {
        if (page === 1) {
          throw new Error(
            `Failed to fetch Supabase auth users: ${err.message}`,
          );
        }
        break;
      }
    }

    this.logger.log(`Found ${allUsers.length} auth users to import`);

    let skippedNoEmail = 0;
    let skippedDuplicate = 0;

    for (const user of allUsers) {
      try {
        const email = user.email;
        if (!email) {
          progress.auth.skipped++;
          skippedNoEmail++;
          continue;
        }

        const meta = user.user_metadata || {};
        const username =
          meta.preferred_username ||
          meta.user_name ||
          meta.name ||
          email.split('@')[0];
        const firstName =
          meta.first_name || meta.full_name?.split(' ')[0] || '';
        const lastName =
          meta.last_name ||
          meta.full_name?.split(' ').slice(1).join(' ') ||
          '';

        const tempPassword = this.generateReadablePassword();

        await this.keycloak.createUser(project.keycloakRealm, {
          email,
          password: tempPassword,
          firstName,
          lastName,
        });

        progress.auth.users++;
      } catch (err: any) {
        if (
          err.response?.status === 409 ||
          err.message?.includes('exists')
        ) {
          progress.auth.skipped++;
          skippedDuplicate++;
        } else {
          const email = user.email || user.id || '(unknown)';
          this.logger.warn(
            `Failed to import user "${email}": ${err.message}`,
          );
          progress.auth.skipped++;
          progress.warnings.push(`Auth user "${email}": ${err.message}`);
        }
      }
    }

    if (skippedNoEmail > 0) {
      progress.warnings.push(
        `Auth: ${skippedNoEmail} user(s) skipped (no email address).`,
      );
    }
    if (skippedDuplicate > 0) {
      progress.warnings.push(
        `Auth: ${skippedDuplicate} user(s) skipped (already exists in Keycloak).`,
      );
    }
  }

  // ── Storage Import ────────────────────────────────────

  private async importStorage(
    baseUrl: string,
    headers: Record<string, string>,
    project: any,
    progress: ImportProgress,
  ) {
    let buckets: SupabaseBucket[] = [];

    try {
      const { data } = await firstValueFrom(
        this.http.get(`${baseUrl}/storage/v1/bucket`, {
          headers,
          timeout: 60000,
        }),
      );
      buckets = data || [];
    } catch (err: any) {
      throw new Error(`Failed to fetch storage buckets: ${err.message}`);
    }

    for (const bucket of buckets) {
      // Step 1: create the bucket (it's OK if it already exists from a previous
      // import attempt — we still want to import/overwrite the objects inside).
      try {
        await this.storage.createBucket(
          project.id,
          undefined,
          bucket.name,
          bucket.public,
        );
        progress.storage.buckets++;
      } catch (err: any) {
        const isConflict =
          err?.status === 409 ||
          err?.response?.statusCode === 409 ||
          (err?.message || '').toLowerCase().includes('already exists');

        if (isConflict) {
          // Bucket already exists — that's fine, proceed to import objects
          this.logger.log(
            `Bucket "${bucket.name}" already exists — proceeding to sync objects`,
          );
          progress.storage.buckets++;
        } else {
          // Any other error: skip this bucket entirely
          this.logger.warn(
            `Failed to create bucket "${bucket.name}": ${err.message}`,
          );
          progress.warnings.push(
            `Bucket "${bucket.name}" import failed: ${err.message}`,
          );
          continue;
        }
      }

      // Step 2: list and upload all objects (putObject overwrites existing keys)
      try {
        const objects = await this.listSupabaseObjects(
          baseUrl,
          headers,
          bucket.id,
        );

        for (const obj of objects) {
          try {
            const fileBuffer = await this.downloadSupabaseObject(
              baseUrl,
              headers,
              bucket.id,
              obj.name,
            );

            const contentType =
              obj.metadata?.mimetype || 'application/octet-stream';

            await this.storage.uploadObject(
              project.id,
              undefined,
              bucket.name,
              obj.name,
              fileBuffer,
              contentType,
            );
            progress.storage.objects++;
          } catch (err: any) {
            this.logger.warn(
              `Failed to import object "${obj.name}" from bucket "${bucket.name}": ${err.message}`,
            );
            progress.warnings.push(
              `Storage object "${bucket.name}/${obj.name}" failed: ${err.message}`,
            );
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to list/upload objects for bucket "${bucket.name}": ${err.message}`,
        );
        progress.warnings.push(
          `Bucket "${bucket.name}" object sync failed: ${err.message}`,
        );
      }
    }
  }

  private async listSupabaseObjects(
    baseUrl: string,
    headers: Record<string, string>,
    bucketId: string,
    prefix = '',
    seenPaths?: Set<string>,
  ): Promise<SupabaseStorageObject[]> {
    const allObjects: SupabaseStorageObject[] = [];
    // seenPaths is shared across all recursive calls for the same bucket
    const seen = seenPaths ?? new Set<string>();

    try {
      // Paginate through all items at this prefix level
      const limit = 1000;
      let offset = 0;
      const allItems: any[] = [];

      while (true) {
        const { data } = await firstValueFrom(
          this.http.post(
            `${baseUrl}/storage/v1/object/list/${encodeURIComponent(bucketId)}`,
            { prefix, limit, offset },
            { headers, timeout: 30000 },
          ),
        );

        if (!Array.isArray(data) || data.length === 0) break;
        allItems.push(...data);
        if (data.length < limit) break;
        offset += limit;
      }

      for (const item of allItems) {
        // A real file has a non-null, non-empty id
        const isFile =
          item.id !== null && item.id !== undefined && item.id !== '';

        if (isFile) {
          const fullPath = prefix ? `${prefix}${item.name}` : item.name;
          // Deduplicate: some Supabase versions return a file both at root
          // level (with its full path) and again inside its folder prefix.
          if (!seen.has(fullPath)) {
            seen.add(fullPath);
            allObjects.push({ ...item, name: fullPath });
          }
        } else if (item.name) {
          // Virtual folder placeholder — recurse into it
          const folderPrefix = prefix
            ? `${prefix}${item.name}/`
            : `${item.name}/`;
          const nested = await this.listSupabaseObjects(
            baseUrl,
            headers,
            bucketId,
            folderPrefix,
            seen,
          );
          allObjects.push(...nested);
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to list objects in bucket "${bucketId}" prefix "${prefix}": ${err.message}`,
      );
    }

    return allObjects;
  }

  private async downloadSupabaseObject(
    baseUrl: string,
    headers: Record<string, string>,
    bucketId: string,
    objectPath: string,
  ): Promise<Buffer> {
    const encodedPath = objectPath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');

    const { data } = await firstValueFrom(
      this.http.get(
        `${baseUrl}/storage/v1/object/${encodeURIComponent(bucketId)}/${encodedPath}`,
        {
          headers,
          responseType: 'arraybuffer',
          timeout: 300000,
        },
      ),
    );

    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return Buffer.from(data as any);
  }
}
