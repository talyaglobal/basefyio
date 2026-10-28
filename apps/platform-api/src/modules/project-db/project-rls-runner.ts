import { ForbiddenException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { jwtClaimSettings } from '../projects/jwt-claim-settings';

export type ProjectDbRole = 'anon' | 'authenticated' | 'service_role';

export interface ProjectRlsContext {
  role: ProjectDbRole;
  /** Decoded JWT payload (claims) — exposed to policies via auth.jwt(). */
  jwtClaims?: Record<string, unknown>;
}

const ALLOWED_ROLES: ReadonlySet<ProjectDbRole> = new Set<ProjectDbRole>([
  'anon',
  'authenticated',
  'service_role',
]);

/** Pools nobody has used for this long are closed by the sweep. */
const POOL_IDLE_MS = 10 * 60 * 1000;
const POOL_SWEEP_MS = 60 * 1000;

/**
 * Runs SQL against a project's own database, either as the project owner
 * (outside row-level security) or dropped down to anon / authenticated /
 * service_role with the caller's JWT claims in place, so the project's RLS
 * policies decide what the statement may touch.
 *
 * This is the same mechanism PublicApiService uses for the REST data API,
 * extracted so other surfaces — the Supabase-compatible storage facade first —
 * can evaluate a request under the project's policies without reaching into
 * that service. It deliberately carries no auto-heal: a project whose owner
 * cannot SET ROLE yet is reported as such, and the data API's bootstrap path
 * (`POST /projects/:id/ensure-rls-bootstrap`) remains the one place that fixes it.
 *
 * Pools are small (max 5) and per project; nothing here holds a transaction
 * open while bytes stream to or from the object store.
 */
@Injectable()
export class ProjectRlsRunner implements OnModuleDestroy {
  private readonly logger = new Logger(ProjectRlsRunner.name);
  private readonly poolCache = new Map<string, { pool: Pool; lastUsed: number }>();
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(private readonly prisma: PrismaService) {
    this.sweep = setInterval(() => this.evictIdlePools(), POOL_SWEEP_MS);
    if (typeof (this.sweep as any).unref === 'function') (this.sweep as any).unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweep);
    const pools = [...this.poolCache.values()];
    this.poolCache.clear();
    await Promise.all(pools.map(({ pool }) => pool.end().catch(() => undefined)));
  }

  /**
   * Runs `fn` inside a transaction with SET LOCAL ROLE and request.jwt.*
   * settings populated; commits on success, rolls back on failure. With
   * `dryRun` the transaction is always rolled back — the way the storage
   * facade asks "would this INSERT be allowed?" without writing anything.
   *
   * A SET ROLE failure (the project predates the RLS bootstrap) is tagged with
   * `__setRoleFailed` so callers can tell it apart from a policy denial.
   */
  async runRlsTransaction<T>(
    projectId: string,
    ctx: ProjectRlsContext,
    fn: (client: PoolClient) => Promise<T>,
    options: { dryRun?: boolean } = {},
  ): Promise<T> {
    if (!ALLOWED_ROLES.has(ctx.role)) {
      throw new ForbiddenException(`Invalid DB role: ${ctx.role}`);
    }
    const pool = await this.getPool(projectId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL ROLE "${ctx.role}"`);
      } catch (roleErr: any) {
        if (roleErr && typeof roleErr === 'object') roleErr.__setRoleFailed = true;
        throw roleErr;
      }

      const claimsJson = ctx.jwtClaims ? JSON.stringify(ctx.jwtClaims) : '{}';
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claimsJson]);
      await client.query(`SELECT set_config('request.jwt.role', $1, true)`, [ctx.role]);
      for (const [key, value] of jwtClaimSettings(ctx.role, ctx.jwtClaims)) {
        await client.query(`SELECT set_config($1, $2, true)`, [key, value]);
      }

      const result = await fn(client);
      await client.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* noop */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` as the project's own database role — the table owner, which RLS
   * does not restrict. For bookkeeping the platform does on the project's
   * behalf (the storage catalog), never for a statement a caller wrote.
   */
  async runAsOwner<T>(projectId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = await this.getPool(projectId);
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /** A pooled connection to the project database; cached per project. */
  async getPool(projectId: string): Promise<Pool> {
    const cached = this.poolCache.get(projectId);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.pool;
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: { dbHost: true, dbPort: true, dbUser: true, dbPassword: true, dbName: true },
    });
    if (!project) {
      throw new ForbiddenException('Project not found or inactive');
    }

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
    pool.on('error', (err) => {
      this.logger.warn(`Idle connection to project ${projectId} failed: ${err.message}`);
    });

    this.poolCache.set(projectId, { pool, lastUsed: Date.now() });
    return pool;
  }

  /** Forget a project's pool (its credentials or host changed, or it was deleted). */
  async dropPool(projectId: string): Promise<void> {
    const entry = this.poolCache.get(projectId);
    if (!entry) return;
    this.poolCache.delete(projectId);
    await entry.pool.end().catch(() => undefined);
  }

  private evictIdlePools(): void {
    const now = Date.now();
    for (const [projectId, entry] of this.poolCache) {
      if (now - entry.lastUsed < POOL_IDLE_MS) continue;
      this.poolCache.delete(projectId);
      entry.pool.end().catch(() => undefined);
    }
  }
}
