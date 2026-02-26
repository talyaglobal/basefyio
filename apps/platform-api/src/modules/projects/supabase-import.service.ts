import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { ProjectsService } from './projects.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { StorageService } from '../storage/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IMPORT_QUEUE, EMAIL_QUEUE } from '../queue/queue.module';
import type { ImportJobData } from '../queue/import.processor';
import type { EmailJobData } from '../queue/email.processor';

export interface ImportProgress {
  database: { tables: number; rows: number; failedTables: string[] };
  auth: { users: number; skipped: number; emailsSent: number };
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

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly projectsService: ProjectsService,
    private readonly keycloak: KeycloakAdminService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    @InjectQueue(IMPORT_QUEUE) private readonly importQueue: Queue,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  /**
   * Enqueue a Supabase import job. Returns immediately with jobId + project.
   */
  async importProject(
    supabaseUrl: string,
    serviceRoleKey: string,
    projectName: string,
    teamId: string,
    userId: string,
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
    const projectName = await this.fetchProjectName(baseUrl, headers);
    const openApi = await this.fetchOpenApiSpec(baseUrl, headers);
    const tables = this.extractTablesFromOpenApi(openApi);

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

  // ── Public methods called by ImportProcessor ─────────────

  async runDatabaseImport(
    baseUrl: string,
    headers: Record<string, string>,
    project: any,
    progress: ImportProgress,
    onProgress?: (detail: string, percent: number) => Promise<void>,
  ) {
    return this.importDatabase(baseUrl, headers, project, progress, onProgress);
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

  private async validateConnection(
    baseUrl: string,
    headers: Record<string, string>,
  ) {
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

    for (const path of Object.keys(paths)) {
      const tableName = path.replace(/^\//, '');
      if (tableName && !tableName.startsWith('rpc/')) {
        tables.push({ table_name: tableName, table_schema: 'public' });
      }
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

          const rowCount = await this.copyTableData(
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

    if (format.endsWith('[]')) return format;
    if (format.startsWith('_')) return format.slice(1) + '[]';

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

    const sql = `CREATE TABLE IF NOT EXISTS "${sanitized}" (\n  ${colDefs.join(',\n  ')}\n)`;

    const client = await pool.connect();
    try {
      await client.query(sql);
      this.logger.log(`Created table "${sanitized}" (${columns.length} columns)`);
    } finally {
      client.release();
    }
  }

  private async copyTableData(
    baseUrl: string,
    headers: Record<string, string>,
    pool: Pool,
    tableName: string,
    columns: SupabaseColumn[],
  ): Promise<number> {
    const sanitized = tableName.replace(/[^a-zA-Z0-9_]/g, '');
    const columnNames = columns.map((c) =>
      c.column_name.replace(/[^a-zA-Z0-9_]/g, ''),
    );
    const typeMap: Record<string, string> = {};
    for (const col of columns) {
      const cleanName = col.column_name.replace(/[^a-zA-Z0-9_]/g, '');
      typeMap[cleanName] = col.data_type;
    }
    let totalRows = 0;
    let offset = 0;
    const pageSize = 1000;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    while (true) {
      let rows: any[];

      try {
        const response = await firstValueFrom(
          this.http.get(
            `${baseUrl}/rest/v1/${encodeURIComponent(tableName)}`,
            {
              headers: {
                ...headers,
                Accept: 'application/json',
                Prefer: 'count=exact',
              },
              params: {
                select: '*',
                limit: pageSize,
                offset,
              },
              timeout: 60000,
            },
          ),
        );
        rows = response.data;
      } catch (err: any) {
        const status = err.response?.status;
        if (status === 416 || status === 404) break;
        this.logger.error(
          `Failed to fetch data from "${tableName}" at offset ${offset}: ${err.message}`,
        );
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(
            `Too many consecutive errors fetching "${tableName}" data`,
          );
        }
        offset += pageSize;
        continue;
      }

      if (!Array.isArray(rows) || rows.length === 0) break;
      consecutiveErrors = 0;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const row of rows) {
          const allKeys = columnNames.filter((k) =>
            Object.prototype.hasOwnProperty.call(row, k),
          );
          if (!allKeys.length) {
            const rowKeys = Object.keys(row);
            if (!rowKeys.length) continue;
            await this.insertSingleRow(client, sanitized, rowKeys, row, typeMap);
          } else {
            await this.insertSingleRow(client, sanitized, allKeys, row, typeMap);
          }
          totalRows++;
        }

        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});

        this.logger.warn(
          `Batch insert failed for "${sanitized}" at offset ${offset}, retrying row-by-row: ${err.message}`,
        );

        const retryClient = await pool.connect();
        try {
          let savedRows = 0;
          for (const row of rows) {
            try {
              const rowKeys = Object.keys(row);
              if (!rowKeys.length) continue;
              await this.insertSingleRow(retryClient, sanitized, rowKeys, row, typeMap);
              savedRows++;
            } catch (rowErr: any) {
              this.logger.warn(
                `Row insert failed in "${sanitized}": ${rowErr.message}`,
              );
            }
          }
          totalRows += savedRows;
        } finally {
          retryClient.release();
        }

        client.release();
        if (rows.length < pageSize) break;
        offset += pageSize;
        continue;
      } finally {
        try {
          client.release();
        } catch {}
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    this.logger.log(`Imported ${totalRows} rows into "${sanitized}"`);
    return totalRows;
  }

  private async insertSingleRow(
    client: any,
    tableName: string,
    keys: string[],
    row: Record<string, any>,
    typeMap: Record<string, string>,
  ) {
    const cleanKeys = keys.map((k) => k.replace(/[^a-zA-Z0-9_]/g, ''));
    const cols = cleanKeys.map((k) => `"${k}"`).join(', ');
    const placeholders = cleanKeys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map((k, i) => {
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
      `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders})`,
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

    for (const user of allUsers) {
      try {
        const email = user.email;
        if (!email) {
          progress.auth.skipped++;
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
          username,
          email,
          password: tempPassword,
          firstName,
          lastName,
        });

        progress.auth.users++;

        // Enqueue credential email
        const emailJob: EmailJobData = {
          type: 'imported-user-credentials',
          to: email,
          username,
          tempPassword,
          projectName,
        };
        await this.emailQueue.add('send-credentials', emailJob, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 3600 },
        });
        progress.auth.emailsSent++;
      } catch (err: any) {
        if (
          err.response?.status === 409 ||
          err.message?.includes('exists')
        ) {
          progress.auth.skipped++;
        } else {
          this.logger.warn(
            `Failed to import user "${user.email}": ${err.message}`,
          );
          progress.auth.skipped++;
        }
      }
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
      try {
        await this.storage.createBucket(
          project.id,
          undefined,
          bucket.name,
          bucket.public,
        );
        progress.storage.buckets++;

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
          `Failed to import bucket "${bucket.name}": ${err.message}`,
        );
        progress.warnings.push(
          `Bucket "${bucket.name}" import failed: ${err.message}`,
        );
      }
    }
  }

  private async listSupabaseObjects(
    baseUrl: string,
    headers: Record<string, string>,
    bucketId: string,
    prefix = '',
  ): Promise<SupabaseStorageObject[]> {
    const allObjects: SupabaseStorageObject[] = [];

    try {
      const { data } = await firstValueFrom(
        this.http.post(
          `${baseUrl}/storage/v1/object/list/${encodeURIComponent(bucketId)}`,
          { prefix, limit: 1000, offset: 0 },
          { headers, timeout: 30000 },
        ),
      );

      if (!Array.isArray(data)) return [];

      for (const item of data) {
        if (item.id) {
          const fullPath = prefix ? `${prefix}${item.name}` : item.name;
          allObjects.push({ ...item, name: fullPath });
        } else if (item.name) {
          const folderPrefix = prefix
            ? `${prefix}${item.name}/`
            : `${item.name}/`;
          const nested = await this.listSupabaseObjects(
            baseUrl,
            headers,
            bucketId,
            folderPrefix,
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
