import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from './projects.service';
import { RealtimeDataService } from '../realtime-data/realtime-data.service';
import { mapPgError } from './pg-error.util';
import { parseQuery } from './postgrest/parser';
import { SelectBuilder } from './postgrest/builder';
import { SchemaCache } from './postgrest/schema-cache';
import { PostgrestParseError } from './postgrest/types';

interface ParsedFilter {
  clause: string;
  values: unknown[];
}

export type PgDbRole = 'anon' | 'authenticated' | 'service_role';

export interface RlsContext {
  role: PgDbRole;
  /** Decoded JWT payload (claims) — will be exposed to policies via auth.jwt(). */
  jwtClaims?: Record<string, unknown>;
}

const OPERATOR_MAP: Record<string, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  is: 'IS',
  in: 'IN',
};

const RESERVED_PARAMS = new Set([
  'select', 'order', 'limit', 'offset', 'on_conflict',
]);

const ALLOWED_ROLES: ReadonlySet<PgDbRole> = new Set<PgDbRole>([
  'anon',
  'authenticated',
  'service_role',
]);

/** Postgres "insufficient_privilege" — emitted by SET LOCAL ROLE when the
 *  connecting user lacks GRANTed membership in the target role. */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

@Injectable()
export class PublicApiService {
  private readonly logger = new Logger(PublicApiService.name);

  /**
   * Tracks the last time we attempted auto-heal for a project. Used to throttle
   * repeated bootstrap calls when a project is permanently broken (e.g. dedicated
   * host, missing roles) without locking it out forever — the previous Set-based
   * implementation never cleared, so a transient failure permanently blocked
   * recovery for the lifetime of the process. With a TTL we'll retry after a
   * cooldown, giving operators a chance to fix the underlying issue.
   */
  private readonly autoHealLastAttemptMs = new Map<string, number>();
  private static readonly AUTO_HEAL_COOLDOWN_MS = 60_000;

  /** Cached connection pools per project. Reused across requests to avoid
   *  creating a new TCP connection + auth handshake on every single query. */
  private readonly poolCache = new Map<string, { pool: Pool; lastUsed: number }>();
  private static readonly POOL_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private poolCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Per-project column and foreign-key catalogue, so embeds resolve without a
   *  round trip per request. Refreshed when a request names something the cache
   *  does not know, which is how a schema change surfaces. */
  private readonly schemaCache = new SchemaCache();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly projectsService: ProjectsService,
    private readonly realtimeData: RealtimeDataService,
  ) {
    // Periodically close idle pools to avoid holding connections to databases
    // that are no longer being queried.
    this.poolCleanupTimer = setInterval(() => this.evictIdlePools(), 60_000);
  }

  private evictIdlePools(): void {
    const now = Date.now();
    for (const [id, entry] of this.poolCache) {
      if (now - entry.lastUsed > PublicApiService.POOL_IDLE_TIMEOUT_MS) {
        entry.pool.end().catch((err) =>
          this.logger.warn(`Failed to close idle pool for ${id}: ${err.message}`),
        );
        this.poolCache.delete(id);
      }
    }
  }

  async select(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
    ctx: RlsContext,
  ) {
    this.validateTableName(table);
    const parsed = parseQuery(query);

    return this.withRls(projectId, ctx, async (client) => {
      // Resolving embeds needs the foreign keys, which the URL cannot carry.
      // If the request names a relation or column the cache has not seen, it is
      // reloaded once — a newly created table surfaces exactly this way — before
      // the request is called wrong.
      const run = async (force: boolean) => {
        const schema = await this.schemaCache.get(projectId, client, force);
        const dataBuilder = new SelectBuilder(schema, this.schemaCache);
        const { sql, params } = dataBuilder.build(table, parsed);

        const countBuilder = new SelectBuilder(schema, this.schemaCache);
        const count = countBuilder.buildCount(table, parsed);

        const [dataResult, countResult] = await Promise.all([
          client.query(sql, params),
          client.query(count.sql, count.params),
        ]);
        return {
          data: dataResult.rows,
          count: countResult.rows[0]?.total ?? 0,
        };
      };

      return this.withSchemaRetry(projectId, run);
    });
  }

  /**
   * Run something that reads the cached schema, and give it one more chance
   * with a fresh one.
   *
   * The URL cannot carry foreign keys or a column list, so a request naming a
   * relation or column the cache has not seen looks like a bad request and is
   * actually a stale cache — a table created a moment ago surfaces exactly
   * this way. Only the three codes that mean "not in the schema" are retried;
   * anything else is the caller's error and is reported as it is.
   */
  private async withSchemaRetry<T>(
    projectId: string,
    run: (force: boolean) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(false);
    } catch (err) {
      if (
        err instanceof PostgrestParseError &&
        (err.code === 'PGRST200' || err.code === 'PGRST204' || err.code === 'PGRST205')
      ) {
        this.schemaCache.invalidate(projectId);
        try {
          return await run(true);
        } catch (retryErr) {
          throw this.toHttp(retryErr);
        }
      }
      throw this.toHttp(err);
    }
  }

  /** Map a parse failure to a 400 that keeps PostgREST's error code; anything
   *  else is left for withRls / mapPgError to classify. */
  private toHttp(err: unknown): unknown {
    if (err instanceof PostgrestParseError) {
      return new BadRequestException({
        message: err.message,
        details: err.details,
        code: err.code,
      });
    }
    return err;
  }

  /**
   * Call a public-schema SQL function as an API endpoint.
   *
   * Args bind by name, and the call runs under the caller's role like every
   * other data-plane request — but that is not by itself enough. A function
   * declared SECURITY DEFINER executes as whoever owns it, which here is the
   * database owner, and the owner is not subject to row-level policy. Such a
   * function is therefore a hole straight through RLS, callable with the
   * public anon key, and `prokind = 'f'` does not notice it.
   *
   * So a definer function is refused for a caller who has not signed in. The
   * owner of the project can still write one and reach it from their server
   * with the service key, or from an app with a signed-in user, which is the
   * usual reason to write one. An anonymous caller gets the invoker-rights
   * functions only, where their policies still apply.
   */
  async rpc(
    projectId: string,
    fnName: string,
    args: Record<string, unknown>,
    ctx: RlsContext,
  ) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fnName)) {
      throw new BadRequestException('Invalid function name');
    }
    return this.withRls(projectId, ctx, async (client) => {
      const meta = await client.query(
        `SELECT p.oid::regprocedure AS signature,
                p.prosecdef AS definer,
                COALESCE(array_to_json(p.proargnames), '[]'::json) AS argnames
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1 AND p.prokind = 'f'
          LIMIT 1`,
        [fnName],
      );
      if (meta.rowCount === 0) {
        throw new BadRequestException(`Function "${fnName}" not found`);
      }
      if (meta.rows[0].definer && ctx.role === 'anon') {
        throw new ForbiddenException(
          `Function "${fnName}" is SECURITY DEFINER, so it runs as the database owner and row-level policies do not apply to it. It cannot be called anonymously — send a signed-in user's access token, or call it from your server with the service key.`,
        );
      }
      const argNames: string[] = meta.rows[0].argnames ?? [];
      const provided = Object.keys(args).filter((k) => argNames.includes(k));
      const params: unknown[] = [];
      const named = provided
        .map((k) => {
          params.push(args[k]);
          return `"${k}" := ${params.length}`;
        })
        .join(', ');
      const result = await client.query(
        `SELECT * FROM "${fnName}"(${named})`,
        params,
      );
      return result.rows;
    });
  }

  async insert(
    projectId: string,
    table: string,
    body: Record<string, unknown> | Record<string, unknown>[],
    returnRepresentation: boolean,
    ctx: RlsContext,
  ) {
    this.validateTableName(table);

    return this.withRls(projectId, ctx, async (client) => {
      const rows = Array.isArray(body) ? body : [body];
      if (!rows.length) throw new BadRequestException('Empty body');

      const keys = Object.keys(rows[0]);
      if (!keys.length) throw new BadRequestException('No columns provided');

      const cols = keys.map((k) => this.quoteIdent(k, 'insert column')).join(', ');

      const allValues: unknown[] = [];
      const valueGroups: string[] = [];

      for (const row of rows) {
        const placeholders: string[] = [];
        for (const key of keys) {
          allValues.push(row[key] ?? null);
          placeholders.push(`$${allValues.length}`);
        }
        valueGroups.push(`(${placeholders.join(', ')})`);
      }

      // RETURNING * unconditionally: response shape below is unchanged, but
      // realtime needs the rows to broadcast full INSERT payloads.
      const sql = `INSERT INTO "${table}" (${cols}) VALUES ${valueGroups.join(', ')} RETURNING *`;

      const result = await client.query(sql, allValues);
      return { __rows: result.rows, __count: result.rowCount };
    }).then((r: any) => {
      for (const row of r.__rows ?? []) {
        this.realtimeData.publishChange(projectId, {
          type: 'INSERT', kind: 'table', entity: table, new: row,
        });
      }
      return returnRepresentation ? r.__rows : { count: r.__count };
    });
  }

  async update(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
    body: Record<string, unknown>,
    returnRepresentation: boolean,
    ctx: RlsContext,
  ) {
    this.validateTableName(table);
    const parsed = parseQuery(query);

    return this.withRls(projectId, ctx, async (client) => {
      const setCols = Object.keys(body);
      if (!setCols.length) throw new BadRequestException('No data to update');

      const run = async (force: boolean) => {
        const schema = await this.schemaCache.get(projectId, client, force);
        const builder = new SelectBuilder(schema, this.schemaCache);
        const { alias, where, params } = builder.buildWriteWhere(table, parsed);
        if (!where) {
          throw new BadRequestException(
            'PATCH requires at least one filter to prevent full-table updates',
          );
        }

        // The filter's parameters are bound first, so the assignments continue
        // the numbering from where it left off.
        let idx = params.length;
        const setClause = setCols
          .map((k) => {
            idx++;
            return `${this.quoteIdent(k, 'update column')} = $${idx}`;
          })
          .join(', ');
        const setValues = setCols.map((k) => body[k] ?? null);

        const sql = `UPDATE "${table}" AS ${alias} SET ${setClause} WHERE ${where} RETURNING *`;
        const result = await client.query(sql, [...params, ...setValues]);
        return { __rows: result.rows, __count: result.rowCount };
      };

      return this.withSchemaRetry(projectId, run);
    }).then((r: any) => {
      for (const row of r.__rows ?? []) {
        this.realtimeData.publishChange(projectId, {
          type: 'UPDATE', kind: 'table', entity: table, new: row,
        });
      }
      return returnRepresentation ? r.__rows : { count: r.__count };
    });
  }

  async delete(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
    returnRepresentation: boolean,
    ctx: RlsContext,
  ) {
    this.validateTableName(table);
    const parsed = parseQuery(query);

    return this.withRls(projectId, ctx, async (client) => {
      const run = async (force: boolean) => {
        const schema = await this.schemaCache.get(projectId, client, force);
        const builder = new SelectBuilder(schema, this.schemaCache);
        const { alias, where, params } = builder.buildWriteWhere(table, parsed);
        if (!where) {
          throw new BadRequestException(
            'DELETE requires at least one filter to prevent full-table deletes',
          );
        }

        const sql = `DELETE FROM "${table}" AS ${alias} WHERE ${where} RETURNING *`;
        const result = await client.query(sql, params);
        return { __rows: result.rows, __count: result.rowCount };
      };

      return this.withSchemaRetry(projectId, run);
    }).then((r: any) => {
      for (const row of r.__rows ?? []) {
        this.realtimeData.publishChange(projectId, {
          type: 'DELETE', kind: 'table', entity: table, old: row,
        });
      }
      return returnRepresentation ? r.__rows : { count: r.__count };
    });
  }

  /* ────────────────────────────── RLS core ────────────────────────────── */

  /**
   * Runs `fn` inside a transaction with SET LOCAL role and
   * request.jwt.claims populated. Any failure rolls back.
   *
   * This is what enforces RLS: the project's DB owner role (e.g. `basefyio_user_<random>`)
   * owns the tables, but we drop down to anon / authenticated / service_role
   * before running the user's query so policies apply.
   *
   * If SET LOCAL ROLE fails with insufficient_privilege (42501), we treat it
   * as "this project DB was provisioned before the RLS bootstrap landed" and
   * try to self-heal once via `ProjectsService.ensureRlsBootstrap()` before
   * retrying the original query. This makes the data API resilient against
   * legacy projects that the operator forgot to backfill.
   */
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
      // Only a SET ROLE membership failure means "this project predates the RLS
      // bootstrap" → try to self-heal. A query-level insufficient_privilege (an
      // RLS policy denial) or any other Postgres error is mapped to a proper
      // HTTP status instead of bubbling up as a generic 500.
      if (!(e?.code === PG_INSUFFICIENT_PRIVILEGE && e.__setRoleFailed)) {
        throw mapPgError(e);
      }

      const lastAttempt = this.autoHealLastAttemptMs.get(projectId) ?? 0;
      const sinceMs = Date.now() - lastAttempt;
      if (sinceMs < PublicApiService.AUTO_HEAL_COOLDOWN_MS) {
        // Recently tried and failed. Surface the underlying error with an
        // actionable message instead of silently looping bootstrap.
        throw new InternalServerErrorException(
          `Project ${projectId} is missing RLS role membership and a recent ` +
            `auto-heal attempt failed ${Math.round(sinceMs / 1000)}s ago. ` +
            `Inspect GET /projects/${projectId}/rls-diagnose, then re-run ` +
            `POST /projects/${projectId}/ensure-rls-bootstrap or ` +
            `apps/platform-api/scripts/backfill-rls.ts.`,
        );
      }

      this.autoHealLastAttemptMs.set(projectId, Date.now());
      this.logger.warn(
        `withRls: SET LOCAL ROLE "${ctx.role}" denied for project ${projectId} ` +
          `(${e.message}). Attempting RLS bootstrap auto-heal.`,
      );

      let healResult: { bootstrappedAt: Date; sentinelPassed: boolean } | null = null;
      try {
        healResult = await this.projectsService.ensureRlsBootstrap(projectId);
      } catch (healErr: any) {
        this.logger.error(
          `withRls: auto-heal failed for project ${projectId}: ${healErr.message}`,
        );
        throw new InternalServerErrorException(
          `Project's RLS roles are not bootstrapped and auto-heal failed: ` +
            `${healErr.message}. Inspect GET /projects/${projectId}/rls-diagnose ` +
            `then re-run POST /projects/${projectId}/ensure-rls-bootstrap.`,
        );
      }

      if (!healResult.sentinelPassed) {
        // Bootstrap "succeeded" but sentinel still reports the role grants
        // are missing. Don't retry the query — would loop on the same 42501.
        throw new InternalServerErrorException(
          `RLS bootstrap completed for project ${projectId} but the SET ROLE ` +
            `sentinel failed; the connecting user is still not a member of ` +
            `anon/authenticated/service_role. ` +
            `Inspect GET /projects/${projectId}/rls-diagnose.`,
        );
      }

      this.logger.log(
        `withRls: auto-heal succeeded for project ${projectId}, retrying request.`,
      );
      // Clear the cooldown marker so a healthy project doesn't carry stale state.
      this.autoHealLastAttemptMs.delete(projectId);
      // One retry post-heal. If this also fails, map the error to a proper status.
      try {
        return await this.runRlsTransaction(projectId, ctx, fn);
      } catch (retryErr: any) {
        throw mapPgError(retryErr);
      }
    }
  }


  /** Inner transaction body — extracted so withRls can retry it after auto-heal. */
  private async runRlsTransaction<T>(
    projectId: string,
    ctx: RlsContext,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = await this.getPool(projectId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // SET LOCAL survives only until COMMIT / ROLLBACK. Tag a failure here so
      // withRls can tell a missing-role-membership (needs bootstrap) apart from
      // a query-level RLS denial (which must surface as 403, not a bootstrap loop).
      try {
        await client.query(`SET LOCAL ROLE "${ctx.role}"`);
      } catch (roleErr: any) {
        if (roleErr && typeof roleErr === 'object') roleErr.__setRoleFailed = true;
        throw roleErr;
      }

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
      } catch {
        /* noop */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  private validateTableName(name: string) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new BadRequestException('Invalid table name');
    }
  }

  private sanitizeIdentifier(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '');
  }

  /**
   * Strict quoter — guarantees we never emit a zero-length delimited
   * identifier (which Postgres rejects with `zero-length delimited identifier`,
   * a generic 500 that's hard to triage from the client side).
   */
  private quoteIdent(name: string, context = 'identifier'): string {
    const safe = this.sanitizeIdentifier(name);
    if (!safe) {
      throw new BadRequestException(`Invalid ${context}: "${name}"`);
    }
    return `"${safe}"`;
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

    this.poolCache.set(projectId, { pool, lastUsed: Date.now() });
    return pool;
  }
}
