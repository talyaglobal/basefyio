import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from './projects.service';
import { RlsContext, PgDbRole } from './public-api.service';
import {
  buildNoSqlFilter,
  buildNoSqlSort,
  buildNoSqlProjection,
} from './nosql-filter.util';

const NOSQL_SCHEMA = 'nosql';
const VALID_COLLECTION_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_DOCUMENT_SIZE_BYTES = 16 * 1024 * 1024;

const ALLOWED_ROLES: ReadonlySet<PgDbRole> = new Set<PgDbRole>([
  'anon',
  'authenticated',
  'service_role',
]);

const PG_INSUFFICIENT_PRIVILEGE = '42501';

@Injectable()
export class PublicCollectionApiService {
  private readonly logger = new Logger(PublicCollectionApiService.name);

  private readonly poolCache = new Map<string, { pool: Pool; lastUsed: number }>();
  private static readonly POOL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  private poolCleanupTimer: ReturnType<typeof setInterval> | null = null;

  private readonly autoHealLastAttemptMs = new Map<string, number>();
  private static readonly AUTO_HEAL_COOLDOWN_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly projectsService: ProjectsService,
  ) {
    this.poolCleanupTimer = setInterval(() => this.evictIdlePools(), 60_000);
  }

  private evictIdlePools(): void {
    const now = Date.now();
    for (const [id, entry] of this.poolCache) {
      if (now - entry.lastUsed > PublicCollectionApiService.POOL_IDLE_TIMEOUT_MS) {
        entry.pool.end().catch((err) =>
          this.logger.warn(`Failed to close idle pool for ${id}: ${err.message}`),
        );
        this.poolCache.delete(id);
      }
    }
  }

  private validateCollectionName(name: string): void {
    if (!VALID_COLLECTION_RE.test(name)) {
      throw new BadRequestException(`Invalid collection name: "${name}"`);
    }
  }

  private qualifiedName(collection: string): string {
    return `"${NOSQL_SCHEMA}"."${collection}"`;
  }

  /* ─────────────── RLS core (mirrors PublicApiService.withRls) ─────────────── */

  private async withRls<T>(
    projectId: string,
    ctx: RlsContext,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!ALLOWED_ROLES.has(ctx.role)) {
      throw new ForbiddenException(`Invalid DB role: ${ctx.role}`);
    }

    try {
      return await this.runRlsTransaction(projectId, ctx, fn);
    } catch (e: any) {
      if (e?.code !== PG_INSUFFICIENT_PRIVILEGE) throw e;

      const lastAttempt = this.autoHealLastAttemptMs.get(projectId) ?? 0;
      const sinceMs = Date.now() - lastAttempt;
      if (sinceMs < PublicCollectionApiService.AUTO_HEAL_COOLDOWN_MS) {
        throw new InternalServerErrorException(
          `Project ${projectId} is missing RLS role membership. Auto-heal attempted ${Math.round(sinceMs / 1000)}s ago.`,
        );
      }

      this.autoHealLastAttemptMs.set(projectId, Date.now());
      this.logger.warn(
        `withRls (collections): SET LOCAL ROLE denied for project ${projectId}. Attempting auto-heal.`,
      );

      try {
        const healResult = await this.projectsService.ensureRlsBootstrap(projectId);
        if (!healResult.sentinelPassed) {
          throw new InternalServerErrorException(
            `RLS bootstrap completed but sentinel failed for project ${projectId}.`,
          );
        }
      } catch (healErr: any) {
        if (healErr instanceof InternalServerErrorException) throw healErr;
        throw new InternalServerErrorException(
          `RLS auto-heal failed: ${healErr.message}`,
        );
      }

      this.autoHealLastAttemptMs.delete(projectId);
      return this.runRlsTransaction(projectId, ctx, fn);
    }
  }

  private async runRlsTransaction<T>(
    projectId: string,
    ctx: RlsContext,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = await this.getPool(projectId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE "${ctx.role}"`);

      const claimsJson = ctx.jwtClaims
        ? JSON.stringify(ctx.jwtClaims)
        : '{}';
      await client.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [claimsJson],
      );
      await client.query(
        `SELECT set_config('request.jwt.role', $1, true)`,
        [ctx.role],
      );

      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
  }

  private async getPool(projectId: string): Promise<Pool> {
    const cached = this.poolCache.get(projectId);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.pool;
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: { dbHost: true, dbPort: true, dbUser: true, dbPassword: true, dbName: true },
    });
    if (!project) throw new ForbiddenException('Project not found or inactive');

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 15_000,
      max: 5,
      idleTimeoutMillis: 30_000,
    });

    this.poolCache.set(projectId, { pool, lastUsed: Date.now() });
    return pool;
  }

  /* ─────────────── Public API methods ─────────────── */

  async findDocuments(
    projectId: string,
    collection: string,
    options: {
      filter?: Record<string, unknown>;
      sort?: Record<string, number>;
      project?: Record<string, 0 | 1>;
      limit?: number;
      offset?: number;
    },
    ctx: RlsContext,
  ) {
    this.validateCollectionName(collection);

    return this.withRls(projectId, ctx, async (client) => {
      const qualified = this.qualifiedName(collection);
      const { where, params } = buildNoSqlFilter(options.filter);
      const orderBy = buildNoSqlSort(options.sort);
      const projection = buildNoSqlProjection(options.project);

      const selectExpr = projection
        ? `id, ${projection} AS data, created_at, updated_at`
        : '*';
      const whereClause = where ? `WHERE ${where}` : '';
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
      const offset = Math.max(options.offset ?? 0, 0);

      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;

      const [dataResult, countResult] = await Promise.all([
        client.query(
          `SELECT ${selectExpr} FROM ${qualified} ${whereClause} ${orderBy ? `ORDER BY ${orderBy}` : ''} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          [...params, limit, offset],
        ),
        client.query(
          `SELECT COUNT(*)::int AS total FROM ${qualified} ${whereClause}`,
          params,
        ),
      ]);

      return {
        data: dataResult.rows,
        count: countResult.rows[0]?.total ?? 0,
      };
    });
  }

  async insertDocuments(
    projectId: string,
    collection: string,
    body: Record<string, unknown> | Record<string, unknown>[],
    returnRepresentation: boolean,
    ctx: RlsContext,
  ) {
    this.validateCollectionName(collection);
    const docs = Array.isArray(body) ? body : [body];
    if (!docs.length) throw new BadRequestException('No documents provided');

    for (const d of docs) {
      const size = Buffer.byteLength(JSON.stringify(d), 'utf8');
      if (size > MAX_DOCUMENT_SIZE_BYTES) {
        throw new BadRequestException('Document exceeds maximum size of 16MB');
      }
    }

    return this.withRls(projectId, ctx, async (client) => {
      const qualified = this.qualifiedName(collection);
      const params: unknown[] = [];
      const valueGroups: string[] = [];

      for (const d of docs) {
        params.push(JSON.stringify(d));
        valueGroups.push(`($${params.length}::jsonb)`);
      }

      const returning = returnRepresentation ? ' RETURNING *' : '';
      const result = await client.query(
        `INSERT INTO ${qualified} (data) VALUES ${valueGroups.join(', ')}${returning}`,
        params,
      );
      return returnRepresentation ? result.rows : { count: result.rowCount };
    });
  }

  async findDocumentById(
    projectId: string,
    collection: string,
    docId: string,
    ctx: RlsContext,
  ) {
    this.validateCollectionName(collection);

    return this.withRls(projectId, ctx, async (client) => {
      const result = await client.query(
        `SELECT * FROM ${this.qualifiedName(collection)} WHERE id = $1`,
        [docId],
      );
      if (result.rowCount === 0) {
        throw new NotFoundException(`Document "${docId}" not found`);
      }
      return result.rows[0];
    });
  }

  async updateDocument(
    projectId: string,
    collection: string,
    docId: string,
    update: Record<string, unknown>,
    returnRepresentation: boolean,
    ctx: RlsContext,
  ) {
    this.validateCollectionName(collection);

    return this.withRls(projectId, ctx, async (client) => {
      const returning = returnRepresentation ? ' RETURNING *' : '';
      const result = await client.query(
        `UPDATE ${this.qualifiedName(collection)}
         SET data = data || $1::jsonb, updated_at = now()
         WHERE id = $2${returning}`,
        [JSON.stringify(update), docId],
      );
      if (result.rowCount === 0) {
        throw new NotFoundException(`Document "${docId}" not found`);
      }
      return returnRepresentation ? result.rows[0] : { count: result.rowCount };
    });
  }

  async replaceDocument(
    projectId: string,
    collection: string,
    docId: string,
    newDoc: Record<string, unknown>,
    returnRepresentation: boolean,
    ctx: RlsContext,
  ) {
    this.validateCollectionName(collection);

    return this.withRls(projectId, ctx, async (client) => {
      const returning = returnRepresentation ? ' RETURNING *' : '';
      const result = await client.query(
        `UPDATE ${this.qualifiedName(collection)}
         SET data = $1::jsonb, updated_at = now()
         WHERE id = $2${returning}`,
        [JSON.stringify(newDoc), docId],
      );
      if (result.rowCount === 0) {
        throw new NotFoundException(`Document "${docId}" not found`);
      }
      return returnRepresentation ? result.rows[0] : { count: result.rowCount };
    });
  }

  async deleteDocument(
    projectId: string,
    collection: string,
    docId: string,
    returnRepresentation: boolean,
    ctx: RlsContext,
  ) {
    this.validateCollectionName(collection);

    return this.withRls(projectId, ctx, async (client) => {
      const returning = returnRepresentation ? ' RETURNING *' : '';
      const result = await client.query(
        `DELETE FROM ${this.qualifiedName(collection)} WHERE id = $1${returning}`,
        [docId],
      );
      if (result.rowCount === 0) {
        throw new NotFoundException(`Document "${docId}" not found`);
      }
      return returnRepresentation ? result.rows[0] : { count: result.rowCount };
    });
  }
}
