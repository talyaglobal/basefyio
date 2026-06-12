import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from './projects.service';
import { RealtimeDataService } from '../realtime-data/realtime-data.service';

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

    return this.withRls(projectId, ctx, async (client) => {
      const columns = this.parseSelect(query.select as string);
      const { where, params } = this.parseFilters(query);
      const orderBy = this.parseOrder(query.order as string);
      const { limitClause, limitParams } = this.parsePagination(query, params.length);

      const sql = [
        `SELECT ${columns} FROM "${table}"`,
        where ? `WHERE ${where}` : '',
        orderBy ? `ORDER BY ${orderBy}` : '',
        limitClause,
      ].filter(Boolean).join(' ');

      const allParams = [...params, ...limitParams];

      const countSql = `SELECT COUNT(*)::int AS total FROM "${table}"${where ? ` WHERE ${where}` : ''}`;
      const [dataResult, countResult] = await Promise.all([
        client.query(sql, allParams),
        client.query(countSql, params),
      ]);

      return {
        data: dataResult.rows,
        count: countResult.rows[0]?.total ?? 0,
      };
    });
  }

  /**
   * Call a public-schema SQL function as an API endpoint (Supabase rpc()).
   * Args bind by name; runs under the caller's RLS role like every other
   * data-plane request.
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
                COALESCE(array_to_json(p.proargnames), '[]'::json) AS argnames
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1 AND p.prokind = 'f'
          LIMIT 1`,
        [fnName],
      );
      if (meta.rowCount === 0) {
        throw new BadRequestException(`Function "${fnName}" not found`);
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

    return this.withRls(projectId, ctx, async (client) => {
      const { where, params } = this.parseFilters(query);
      if (!where) {
        throw new BadRequestException('PATCH requires at least one filter to prevent full-table updates');
      }

      const setCols = Object.keys(body);
      if (!setCols.length) throw new BadRequestException('No data to update');

      let idx = params.length;
      const setClause = setCols
        .map((k) => {
          idx++;
          return `${this.quoteIdent(k, 'update column')} = $${idx}`;
        })
        .join(', ');

      const setValues = setCols.map((k) => body[k] ?? null);
      const sql = `UPDATE "${table}" SET ${setClause} WHERE ${where} RETURNING *`;

      const result = await client.query(sql, [...params, ...setValues]);
      return { __rows: result.rows, __count: result.rowCount };
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

    return this.withRls(projectId, ctx, async (client) => {
      const { where, params } = this.parseFilters(query);
      if (!where) {
        throw new BadRequestException('DELETE requires at least one filter to prevent full-table deletes');
      }

      const sql = `DELETE FROM "${table}" WHERE ${where} RETURNING *`;

      const result = await client.query(sql, params);
      return { __rows: result.rows, __count: result.rowCount };
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
      if (e?.code !== PG_INSUFFICIENT_PRIVILEGE) {
        throw e;
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
      // One retry post-heal. If this also fails, surface the original code path.
      return this.runRlsTransaction(projectId, ctx, fn);
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
      // SET LOCAL survives only until COMMIT / ROLLBACK.
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
      } catch {
        /* noop */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  private parseSelect(selectParam?: string): string {
    if (!selectParam) return '*';

    const cols = selectParam.split(',').map((c) => c.trim()).filter(Boolean);
    if (!cols.length) return '*';

    // PostgREST-compatible: `?select=*` (or `*` mixed with explicit columns)
    // means "all columns". Without this, sanitizeIdentifier strips the star
    // and we emit `SELECT "" FROM ...` → Postgres "zero-length delimited
    // identifier" 500.
    return cols
      .map((c) => {
        if (c === '*') return '*';
        const safe = this.sanitizeIdentifier(c);
        if (!safe) {
          throw new BadRequestException(`Invalid column in select: "${c}"`);
        }
        return `"${safe}"`;
      })
      .join(', ');
  }

  private parseFilters(
    query: Record<string, string | string[]>,
  ): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const [key, raw] of Object.entries(query)) {
      if (RESERVED_PARAMS.has(key)) continue;
      if (!key.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) continue;

      const values = Array.isArray(raw) ? raw : [raw];

      for (const value of values) {
        const parsed = this.parseOperatorValue(key, value, params.length);
        if (parsed) {
          clauses.push(parsed.clause);
          params.push(...parsed.values);
        }
      }
    }

    return {
      where: clauses.length ? clauses.join(' AND ') : '',
      params,
    };
  }

  private parseOperatorValue(
    column: string,
    value: string,
    paramOffset: number,
  ): ParsedFilter | null {
    const dotIdx = value.indexOf('.');
    if (dotIdx === -1) return null;

    const op = value.substring(0, dotIdx);
    const val = value.substring(dotIdx + 1);
    const sqlOp = OPERATOR_MAP[op];

    if (!sqlOp) return null;

    const col = this.quoteIdent(column, 'filter column');

    if (op === 'is') {
      if (val === 'null') return { clause: `${col} IS NULL`, values: [] };
      if (val === 'true') return { clause: `${col} IS TRUE`, values: [] };
      if (val === 'false') return { clause: `${col} IS FALSE`, values: [] };
      return null;
    }

    if (op === 'in') {
      const items = val
        .replace(/^\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .map((s) => s.trim());

      const placeholders: string[] = [];
      const values: unknown[] = [];
      for (const item of items) {
        values.push(item);
        placeholders.push(`$${paramOffset + values.length}`);
      }

      return {
        clause: `${col} IN (${placeholders.join(', ')})`,
        values,
      };
    }

    if (op === 'like' || op === 'ilike') {
      const pattern = val.replace(/\*/g, '%');
      return {
        clause: `${col} ${sqlOp} $${paramOffset + 1}`,
        values: [pattern],
      };
    }

    return {
      clause: `${col} ${sqlOp} $${paramOffset + 1}`,
      values: [val],
    };
  }

  private parseOrder(orderParam?: string): string {
    if (!orderParam) return '';

    return orderParam
      .split(',')
      .map((part) => {
        const [col, dir] = part.trim().split('.');
        const safeCol = this.quoteIdent(col, 'order column');
        const safeDir = dir?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        const nulls = safeDir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';
        return `${safeCol} ${safeDir} ${nulls}`;
      })
      .join(', ');
  }

  private parsePagination(
    query: Record<string, string | string[]>,
    paramOffset: number,
  ): { limitClause: string; limitParams: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];

    const limit = parseInt(query.limit as string, 10);
    if (!isNaN(limit) && limit > 0) {
      params.push(Math.min(limit, 1000));
      parts.push(`LIMIT $${paramOffset + params.length}`);
    } else {
      params.push(100);
      parts.push(`LIMIT $${paramOffset + params.length}`);
    }

    const offset = parseInt(query.offset as string, 10);
    if (!isNaN(offset) && offset > 0) {
      params.push(offset);
      parts.push(`OFFSET $${paramOffset + params.length}`);
    }

    return { limitClause: parts.join(' '), limitParams: params };
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
