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
import { mapPgError } from './pg-error.util';
import { jwtClaimSettings } from './jwt-claim-settings';
import { parseQuery, parseSelect } from './postgrest/parser';
import { SelectBuilder } from './postgrest/builder';
import { ProjectSchema, SchemaCache } from './postgrest/schema-cache';
import { CountMode, MAX_ROWS, ParsedQuery, PostgrestParseError, SelectItem } from './postgrest/types';
import { parseRangeHeader, projectRows } from './postgrest/response';
import {
  assertRows,
  buildInsertStatements,
  INSERTED_FLAG,
  parseOnConflict,
  UpsertResolution,
} from './postgrest/write';
import { planRpcCall, RpcOverloadRow } from './postgrest/rpc';

export type PgDbRole = 'anon' | 'authenticated' | 'service_role';

export interface RlsContext {
  role: PgDbRole;
  /** Decoded JWT payload (claims) — will be exposed to policies via auth.jwt(). */
  jwtClaims?: Record<string, unknown>;
}

export interface SelectOptions {
  /** `Prefer: count=…`; a `?count=` in the query wins over it. */
  count?: CountMode;
  /** The raw `Range` / `Range-Unit` headers, used when the query sets no limit or offset. */
  range?: string;
  rangeUnit?: string;
}

export interface SelectResult {
  data: Record<string, unknown>[];
  /** The total, or null when the caller asked for no count. */
  count: number | null;
  /** Where the page starts, for Content-Range. */
  offset: number;
  /** How the count was arrived at, when there is one. */
  countMethod: 'exact' | 'planned' | null;
}

export interface WriteOptions {
  /** `Prefer: return=representation` — answer with the rows rather than a count. */
  returnRepresentation: boolean;
  /** `?select=` — the columns of the rows returned. */
  select?: unknown;
}

export interface InsertOptions extends WriteOptions {
  /** `Prefer: resolution=…` turns the insert into an upsert. */
  resolution?: UpsertResolution;
  /** `?on_conflict=` — the unique column(s) an upsert resolves on; the primary key otherwise. */
  onConflict?: unknown;
}

const ALLOWED_ROLES: ReadonlySet<PgDbRole> = new Set<PgDbRole>([
  'anon',
  'authenticated',
  'service_role',
]);

/** Postgres "insufficient_privilege" — emitted by SET LOCAL ROLE when the
 *  connecting user lacks GRANTed membership in the target role. */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Up to this many matching rows, a read's `count` is exact even when nobody
 * asked for `count=exact`; past it, the planner's estimate stands in. Counting
 * every row of a large table on every page was most of the cost of a read.
 */
export const EXACT_COUNT_THRESHOLD = 10_000;

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

  /**
   * Read rows.
   *
   * The `count` beside them no longer costs a full COUNT on every request.
   * A page that comes back short already shows the total; otherwise rows are
   * counted exactly up to {@link EXACT_COUNT_THRESHOLD} and estimated past it.
   * `Prefer: count=exact` (or `?count=exact`) counts every row as before,
   * `count=planned` always estimates and `count=none` skips the count. The
   * response keeps its `{ data, count }` shape throughout.
   */
  async select(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
    ctx: RlsContext,
    opts: SelectOptions = {},
  ): Promise<SelectResult> {
    this.validateTableName(table);
    const parsed = this.parse(query);
    const range = this.parseHttp(() => parseRangeHeader(opts.range, opts.rangeUnit));
    if (range && !parsed.limit.has('') && !parsed.offset.has('')) {
      parsed.offset.set('', range.offset);
      if (range.limit !== undefined) parsed.limit.set('', Math.min(range.limit, MAX_ROWS));
    }
    const mode: CountMode = parsed.count ?? opts.count ?? 'estimated';

    return this.withRls(projectId, ctx, async (client) => {
      // Resolving embeds needs the foreign keys, which the URL cannot carry.
      // If the request names a relation or column the cache has not seen, it is
      // reloaded once — a newly created table surfaces exactly this way — before
      // the request is called wrong.
      const run = async (force: boolean): Promise<SelectResult> => {
        const schema = await this.schemaCache.get(projectId, client, force);
        const { sql, params } = new SelectBuilder(schema, this.schemaCache).build(table, parsed);
        const dataResult = await client.query(sql, params);
        const rows = dataResult.rows as Record<string, unknown>[];
        const offset = parsed.offset.get('') ?? 0;
        const limit = parsed.limit.get('') ?? MAX_ROWS;
        const counted = await this.countRows(client, schema, table, parsed, mode, {
          returned: rows.length,
          offset,
          limit,
        });
        return { data: rows, count: counted.total, offset, countMethod: counted.method };
      };

      return this.withSchemaRetry(projectId, run);
    });
  }

  /**
   * The total behind a page of rows, as cheaply as the requested mode allows.
   *
   * Whatever the mode, a page that came back short — fewer rows than the limit,
   * and not because the offset ran past the end — already is the total: no
   * query at all. That is every read of a small table.
   */
  private async countRows(
    client: PoolClient,
    schema: ProjectSchema,
    table: string,
    parsed: ParsedQuery,
    mode: CountMode,
    page: { returned: number; offset: number; limit: number },
  ): Promise<{ total: number | null; method: 'exact' | 'planned' | null }> {
    if (mode === 'none') return { total: null, method: null };
    const { returned, offset, limit } = page;
    if (returned < limit && (returned > 0 || offset === 0)) {
      return { total: offset + returned, method: 'exact' };
    }
    const builder = () => new SelectBuilder(schema, this.schemaCache);

    if (mode === 'exact') {
      const c = builder().buildCount(table, parsed);
      const r = await client.query(c.sql, c.params);
      return { total: Number(r.rows[0]?.total ?? 0), method: 'exact' };
    }
    if (mode === 'estimated') {
      const c = builder().buildBoundedCount(table, parsed, EXACT_COUNT_THRESHOLD);
      const r = await client.query(c.sql, c.params);
      const n = Number(r.rows[0]?.total ?? 0);
      if (n <= EXACT_COUNT_THRESHOLD) return { total: n, method: 'exact' };
    }

    // The planner's estimate. EXPLAIN runs behind a savepoint: if it cannot
    // run, the read still answers, with a count of null rather than an error.
    const p = builder().buildPlannedCount(table, parsed);
    await client.query('SAVEPOINT _bf_count');
    try {
      const r = await client.query(p.sql, p.params);
      await client.query('RELEASE SAVEPOINT _bf_count');
      const plan = (r.rows[0]?.['QUERY PLAN'] as Array<{ Plan?: { 'Plan Rows'?: number } }> | undefined)?.[0]?.Plan;
      const estimate = Math.round(Number(plan?.['Plan Rows'] ?? 0));
      // Never report fewer rows than are known to exist.
      const floor = mode === 'estimated' ? EXACT_COUNT_THRESHOLD + 1 : offset + returned;
      return { total: Math.max(estimate, floor), method: 'planned' };
    } catch (err: any) {
      await client.query('ROLLBACK TO SAVEPOINT _bf_count');
      this.logger.warn(`Planned count failed on "${table}": ${err?.message ?? err}`);
      return { total: null, method: null };
    }
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
   *
   * `run` must not have written anything before it throws one of those codes,
   * since it runs again in the same transaction.
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
   * Parse the query string. A malformed one — a filter with no operator, an
   * unknown operator or order modifier, a character no column name can hold —
   * is the caller's mistake and answers 400 with what was wrong, not a 500.
   */
  private parse(query: Record<string, string | string[]>): ParsedQuery {
    return this.parseHttp(() => parseQuery(query));
  }

  private parseHttp<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw this.toHttp(err);
    }
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
   *
   * Which overload a call reaches is worked out from the argument names before
   * anything runs (see planRpcCall), so the definer check looks at the
   * function that can actually be called, and a call that matches nothing is
   * told which arguments exist instead of failing inside Postgres.
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
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new BadRequestException(
        'The request body must be a JSON object of argument name → value, e.g. {"name": "world"}',
      );
    }
    return this.withRls(projectId, ctx, async (client) => {
      const meta = await client.query(
        `SELECT p.oid::regprocedure::text AS signature,
                p.prosecdef AS definer,
                p.pronargdefaults AS ndefaults,
                COALESCE(array_to_json(p.proargnames), '[]'::json) AS argnames,
                COALESCE(array_to_json(p.proargmodes), '[]'::json) AS argmodes,
                array_to_json(COALESCE(p.proallargtypes, p.proargtypes::oid[])::regtype[]) AS argtypes
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1 AND p.prokind = 'f'`,
        [fnName],
      );
      if (meta.rowCount === 0) {
        throw new BadRequestException(`Function "${fnName}" not found`);
      }
      const plan = this.parseHttp(() =>
        planRpcCall(fnName, meta.rows as RpcOverloadRow[], args),
      );
      if (plan.definer && ctx.role === 'anon') {
        throw new ForbiddenException(
          `Function "${fnName}" is SECURITY DEFINER, so it runs as the database owner and row-level policies do not apply to it. It cannot be called anonymously — send a signed-in user's access token, or call it from your server with the service key.`,
        );
      }
      const result = await client.query(
        `SELECT * FROM "${fnName}"(${plan.named})`,
        plan.params,
      );
      return result.rows;
    });
  }

  /**
   * Insert rows — or upsert them, with `Prefer: resolution=merge-duplicates`
   * (update the existing row) or `resolution=ignore-duplicates` (keep it).
   *
   * An upsert resolves on the `?on_conflict=` columns, or the primary key when
   * none are named. It runs exactly where an insert runs: under the caller's
   * role in the same RLS transaction, so policies decide as they would for an
   * INSERT and, for the rows it updates, an UPDATE. Every value is bound.
   *
   * A large batch is split into statements under Postgres' parameter ceiling,
   * all in one transaction, so it lands whole or not at all.
   */
  async insert(
    projectId: string,
    table: string,
    body: unknown,
    options: InsertOptions | boolean,
    ctx: RlsContext,
  ) {
    // A bare boolean is the original signature (return the rows or not), kept for in-process callers.
    const opts: InsertOptions =
      typeof options === 'boolean' ? { returnRepresentation: options } : options;
    this.validateTableName(table);
    const rows = this.parseHttp(() => assertRows(body));
    const select = this.parseSelectOnWrite(opts.select);
    const onConflict = opts.resolution
      ? this.parseHttp(() => parseOnConflict(opts.onConflict))
      : undefined;

    return this.withRls(projectId, ctx, async (client) => {
      let upsert: { resolution: UpsertResolution; target: string[] | null } | undefined;
      if (opts.resolution) {
        const target =
          onConflict ??
          (await this.withSchemaRetry(projectId, async (force) => {
            const schema = await this.schemaCache.get(projectId, client, force);
            const info = schema.tables.get(table);
            if (!info) {
              throw new PostgrestParseError(`Relation "${table}" not found`, undefined, 'PGRST205');
            }
            return info.primaryKey.length ? [...info.primaryKey] : null;
          }));
        upsert = { resolution: opts.resolution, target };
      }

      const statements = this.parseHttp(() =>
        buildInsertStatements({
          table,
          rows,
          quote: (name, context) => this.quoteIdent(name, context),
          upsert,
        }),
      );

      const written: Record<string, unknown>[] = [];
      let count = 0;
      for (const statement of statements) {
        const result = await client.query(statement.sql, statement.params);
        written.push(...(result.rows as Record<string, unknown>[]));
        count += result.rowCount ?? 0;
      }

      // Which rows an upsert created and which it updated, for realtime; the
      // marker column is not part of the table and never reaches the caller.
      const inserted = written.map((row) => (upsert ? row[INSERTED_FLAG] !== false : true));
      if (upsert) for (const row of written) delete row[INSERTED_FLAG];

      // Shaped inside the transaction: a select that names a column the rows
      // do not have is refused before anything is committed.
      const shaped = this.shapeWritten(written, select, opts.returnRepresentation);
      return { written, inserted, count, shaped };
    }).then((r) => {
      r.written.forEach((row, i) => {
        this.realtimeData.publishChange(projectId, {
          type: r.inserted[i] ? 'INSERT' : 'UPDATE', kind: 'table', entity: table, new: row,
        });
      });
      return opts.returnRepresentation ? r.shaped : { count: r.count };
    });
  }

  async update(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
    body: unknown,
    options: WriteOptions | boolean,
    ctx: RlsContext,
  ) {
    const opts: WriteOptions =
      typeof options === 'boolean' ? { returnRepresentation: options } : options;
    this.validateTableName(table);
    const parsed = this.parse(query);
    const select = this.parseSelectOnWrite(opts.select);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('PATCH takes one JSON object of column → new value');
    }
    const data = body as Record<string, unknown>;

    return this.withRls(projectId, ctx, async (client) => {
      const setCols = Object.keys(data);
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
        return { alias, where, params };
      };
      const { alias, where, params } = await this.withSchemaRetry(projectId, run);

      // The filter's parameters are bound first, so the assignments continue
      // the numbering from where it left off.
      let idx = params.length;
      const setClause = setCols
        .map((k) => {
          idx++;
          return `${this.quoteIdent(k, 'update column')} = $${idx}`;
        })
        .join(', ');
      const setValues = setCols.map((k) => data[k] ?? null);

      const sql = `UPDATE "${table}" AS ${alias} SET ${setClause} WHERE ${where} RETURNING *`;
      const result = await client.query(sql, [...params, ...setValues]);
      const written = result.rows as Record<string, unknown>[];
      return {
        written,
        count: result.rowCount,
        shaped: this.shapeWritten(written, select, opts.returnRepresentation),
      };
    }).then((r) => {
      for (const row of r.written) {
        this.realtimeData.publishChange(projectId, {
          type: 'UPDATE', kind: 'table', entity: table, new: row,
        });
      }
      return opts.returnRepresentation ? r.shaped : { count: r.count };
    });
  }

  async delete(
    projectId: string,
    table: string,
    query: Record<string, string | string[]>,
    options: WriteOptions | boolean,
    ctx: RlsContext,
  ) {
    const opts: WriteOptions =
      typeof options === 'boolean' ? { returnRepresentation: options } : options;
    this.validateTableName(table);
    const parsed = this.parse(query);
    const select = this.parseSelectOnWrite(opts.select);

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
        return { alias, where, params };
      };
      const { alias, where, params } = await this.withSchemaRetry(projectId, run);

      const sql = `DELETE FROM "${table}" AS ${alias} WHERE ${where} RETURNING *`;
      const result = await client.query(sql, params);
      const written = result.rows as Record<string, unknown>[];
      return {
        written,
        count: result.rowCount,
        shaped: this.shapeWritten(written, select, opts.returnRepresentation),
      };
    }).then((r) => {
      for (const row of r.written) {
        this.realtimeData.publishChange(projectId, {
          type: 'DELETE', kind: 'table', entity: table, old: row,
        });
      }
      return opts.returnRepresentation ? r.shaped : { count: r.count };
    });
  }

  /** `?select=` on a write, parsed up front so a bad one is refused before anything runs. */
  private parseSelectOnWrite(raw: unknown): SelectItem[] | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') {
      throw new BadRequestException('Malformed select parameter');
    }
    return this.parseHttp(() => parseSelect(raw));
  }

  private shapeWritten(
    rows: Record<string, unknown>[],
    select: SelectItem[] | undefined,
    returnRepresentation: boolean,
  ): Record<string, unknown>[] {
    if (!returnRepresentation || !select) return rows;
    return this.parseHttp(() => projectRows(rows, select));
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
        throw mapPgError(this.toHttp(e));
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
        throw mapPgError(this.toHttp(retryErr));
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
      // Single-claim keys for helpers written against request.jwt.claim.<name>
      // (imported schemas); see jwt-claim-settings.ts.
      for (const [key, value] of jwtClaimSettings(ctx.role, ctx.jwtClaims)) {
        await client.query(`SELECT set_config($1, $2, true)`, [key, value]);
      }

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
