import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Client, Pool, QueryResult } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { ProjectsService } from '../projects/projects.service';
import { RealtimeDataService } from '../realtime-data/realtime-data.service';
import { jwtClaimSettings } from '../projects/jwt-claim-settings';
import { describePgError, isPgError } from '../projects/pg-user-error.util';
import { findForbiddenSqlPattern, SqlCallerRole } from './sql-guard';
import {
  classifyStatement,
  splitStatements,
  StatementInfo,
  tokenize,
} from './sql-lexer';

/** Postgres "insufficient_privilege" — SET LOCAL ROLE raises this when the
 *  connecting db user was never granted membership in the target role. */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

/** Postgres "read_only_sql_transaction". */
const PG_READ_ONLY_TRANSACTION = '25006';

/**
 * Rows returned per SELECT of a multi-statement script when the caller does
 * not ask for a smaller cap. A script runs as one round trip and cannot be
 * paged, and an uncapped `SELECT * FROM big; SELECT 1` used to send every row
 * of `big` through the API and into the browser.
 */
export const SCRIPT_ROW_CAP = 10_000;

/** Largest `maxRows` a caller may ask for. */
export const MAX_ROWS_CEILING = 10_000;

/**
 * How an API-key call must run against the project database.
 *
 * A dashboard editor (a team member, proven by JWT) runs as the owner — that is
 * the SQL editor, and it is meant to see everything. A call authenticated by an
 * API key does not: it runs under the key's database role so that row-level
 * security applies. `anon` has SELECT only, so the public key can read what
 * policy allows and write nothing; `authenticated` carries the user's claims;
 * `service_role` is the secret server key and bypasses RLS by design.
 */
export interface SqlRlsContext {
  role: 'anon' | 'authenticated' | 'service_role';
  jwtClaims?: Record<string, unknown>;
}

export interface SqlField {
  name: string;
  dataTypeId: number;
}

export interface SqlResultSet {
  fields?: SqlField[];
  rows: Record<string, unknown>[];
  rowCount: number | null;
  /** More rows existed than were returned (see `maxRows` / SCRIPT_ROW_CAP). */
  truncated?: boolean;
}

/**
 * Column names made unique for row objects. `SELECT count(*), count(*) …`
 * produces two columns called `count`; as object keys the second overwrote the
 * first and the result showed one column with the wrong value. Repeats get a
 * suffix — `count`, `count_1` — that does not collide with a real column.
 */
export function uniqueColumnNames(names: string[]): string[] {
  const taken = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    let name = raw;
    if (taken.has(name)) {
      let n = 1;
      while (taken.has(`${raw}_${n}`) || names.includes(`${raw}_${n}`)) n++;
      name = `${raw}_${n}`;
    }
    taken.add(name);
    out.push(name);
  }
  return out;
}

/** A node-pg result fetched with rowMode 'array', as named rows. */
function toResultSet(r: QueryResult, cap?: number): SqlResultSet {
  const names = uniqueColumnNames((r.fields ?? []).map((f) => f.name));
  let rows = (r.rows as unknown[][]) ?? [];
  let truncated = false;
  if (cap !== undefined && rows.length > cap) {
    rows = rows.slice(0, cap);
    truncated = true;
  }
  return {
    fields: r.fields?.length
      ? r.fields.map((f, i) => ({ name: names[i], dataTypeId: f.dataTypeID }))
      : r.fields
        ? []
        : undefined,
    rows: rows.map((values) => {
      const row: Record<string, unknown> = {};
      names.forEach((name, i) => {
        row[name] = Array.isArray(values) ? values[i] : undefined;
      });
      return row;
    }),
    rowCount: r.rowCount,
    ...(truncated ? { truncated } : {}),
  };
}

interface RunningQuery {
  projectId: string;
  userId: string;
  pid: number;
}

@Injectable()
export class SqlService implements OnModuleDestroy {
  private readonly logger = new Logger(SqlService.name);

  /**
   * One connection pool per project, reused across queries (previously a new
   * Pool was opened and closed on every execute — which defeated pooling and
   * risked connection exhaustion under load). Keyed by projectId; if the
   * project's connection params change (e.g. password reset), the stale pool is
   * closed and replaced.
   */
  private readonly pools = new Map<string, { pool: Pool; hash: string }>();

  /** Statements a dashboard user started with a runId, so they can cancel them. */
  private readonly running = new Map<string, RunningQuery>();

  private getPool(project: {
    id: string;
    dbHost: string;
    dbPort: number;
    dbUser: string;
    dbPassword: string;
    dbName: string;
  }): Pool {
    const hash = createHash('sha1')
      .update(
        `${project.dbHost}:${project.dbPort}:${project.dbUser}:${project.dbPassword}:${project.dbName}`,
      )
      .digest('hex');
    const existing = this.pools.get(project.id);
    if (existing && existing.hash === hash) return existing.pool;
    if (existing) {
      // Connection params changed — drop the stale pool.
      existing.pool.end().catch(() => undefined);
      this.pools.delete(project.id);
    }
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 30_000,
      max: 5,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    pool.on('error', (e) => {
      this.logger.warn(`Project DB pool error (${project.id}): ${e.message}`);
      this.pools.delete(project.id);
      pool.end().catch(() => undefined);
    });
    this.pools.set(project.id, { pool, hash });
    return pool;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.pools.values()].map(({ pool }) => pool.end().catch(() => undefined)),
    );
    this.pools.clear();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly activity: ProjectActivityService,
    private readonly embeddingService: EmbeddingService,
    private readonly projectsService: ProjectsService,
    @Optional() private readonly realtimeData?: RealtimeDataService,
  ) {}

  /** The project, if `userId` (when given) belongs to its team. */
  private async loadProject(projectId: string, userId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (userId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!membership) {
        throw new NotFoundException('Project not found');
      }
      return { project, membership };
    }
    return { project, membership: null };
  }

  async execute(
    projectId: string,
    query: string,
    userId?: string,
    opts?: {
      page?: number;
      limit?: number;
      countTotal?: boolean;
      /** Values for `$1 … $n`; see `ExecuteSqlDto.params` for why they travel apart. */
      params?: unknown[];
      /**
       * Present when the caller authenticated with an API key rather than a
       * dashboard login. The statement then runs under this database role, so
       * RLS applies. Absent for a dashboard team member, who keeps owner access
       * (the SQL editor) exactly as before.
       */
      rls?: SqlRlsContext;
      /**
       * Run the statement in a READ ONLY transaction. The SQL editor sets it
       * when it re-runs a query to fetch another page, so a statement that
       * writes is refused rather than repeated.
       */
      readOnly?: boolean;
      /** Cap on rows returned by statements that cannot be paged. */
      maxRows?: number;
      /** Leave out `resultSets` when it would only repeat `rows`. */
      compact?: boolean;
      /** Caller-chosen id under which a dashboard user can cancel this run. */
      runId?: string;
    },
  ) {
    const { project } = await this.loadProject(projectId, userId);

    // A dashboard team member is the owner in the SQL editor and keeps DDL; a
    // key-authed caller is only as privileged as the role it runs under.
    this.validateQuery(query, opts?.rls ? opts.rls.role : 'owner');

    // Bound values are never part of the statement, so `validateQuery` never
    // sees them — which is the point rather than a gap. The guard scans the SQL
    // that will run, literals included, because a literal is where a smuggled
    // COPY would hide. Sent apart, a value cannot be read as an operation and
    // cannot become syntax. Every character of the statement is still scanned.
    const values = opts?.params?.length ? opts.params : undefined;

    const page = Math.max(1, opts?.page ?? 1);
    const limit = Math.min(Math.max(1, opts?.limit ?? 100), 1000);
    const offset = (page - 1) * limit;
    const maxRows =
      opts?.maxRows !== undefined
        ? Math.min(Math.max(1, Math.floor(opts.maxRows)), MAX_ROWS_CEILING)
        : undefined;

    // Statements are found on tokens, so a semicolon or a keyword inside a
    // string, a comment or a dollar-quoted body is never mistaken for syntax.
    const statements = splitStatements(query, tokenize(query));
    const infos: StatementInfo[] = statements.map((s) => classifyStatement(s.tokens));
    const multi = statements.length > 1;

    // The extended protocol carries one statement, so a parameterised script
    // cannot go out in one round trip. Said in a sentence here rather than left
    // to the driver, whose "cannot insert multiple commands into a prepared
    // statement" reads like a syntax error in the caller's own SQL.
    if (values && multi) {
      throw new BadRequestException(
        'Parameters can only be used with a single statement. Send one statement per call.',
      );
    }
    // Postgres binds at most 65535 parameters per statement; past that the
    // driver raises a protocol error with no advice in it.
    if (values && values.length > 65535) {
      throw new BadRequestException(
        `Too many parameters (${values.length}); Postgres binds at most 65535 per statement. Send the rows in batches.`,
      );
    }

    // Only a plain read can be paged: it is wrapped in a subquery and run
    // again for every page. A WITH that modifies data cannot be a subquery
    // ("WITH clause containing a data-modifying statement must be at the top
    // level") and must not be repeated, so it runs once, as written.
    const single = !multi && statements.length === 1 ? statements[0] : null;
    const singleInfo = single ? infos[0] : null;
    const canPaginate = singleInfo?.kind === 'select';

    let runQuery: string;
    /** Cap applied to each result set after it arrives (undefined = none). */
    let resultCap: number | undefined;
    if (single && canPaginate) {
      runQuery = `SELECT * FROM (\n${single.text}\n) AS _bf_paged LIMIT ${limit} OFFSET ${offset}`;
    } else if (single) {
      resultCap = maxRows;
      runQuery =
        singleInfo?.kind === 'select_with_dml' && !singleInfo.hasTopLevelLimit && maxRows !== undefined
          ? `${single.text}\nLIMIT ${maxRows + 1}`
          : query;
    } else if (multi) {
      // A script runs as one simple query (one implicit transaction, exactly as
      // before). Each read in it is capped where it runs; everything else is
      // sent as written.
      const cap = maxRows ?? SCRIPT_ROW_CAP;
      resultCap = cap;
      runQuery = statements
        .map((s, i) => {
          const info = infos[i];
          if (info.kind === 'select') {
            return `SELECT * FROM (\n${s.text}\n) AS _bf_capped LIMIT ${cap + 1}`;
          }
          if (info.kind === 'select_with_dml' && !info.hasTopLevelLimit) {
            return `${s.text}\nLIMIT ${cap + 1}`;
          }
          return s.text;
        })
        .join(';\n');
    } else {
      runQuery = query; // nothing but comments / whitespace
    }

    const countSql =
      single && canPaginate && opts?.countTotal
        ? `SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM (\n${single.text}\n) AS _bf_paged_count LIMIT 10001) sub`
        : null;

    const readOnly = Boolean(opts?.readOnly);
    const runId = opts?.runId && userId && !opts?.rls ? opts.runId : undefined;
    const startTime = Date.now();
    let total: number | null = null;
    let totalIsApprox = false;

    try {
      // A dashboard editor runs as owner; an API-key caller runs under its DB
      // role so RLS applies. runWithRole owns the connection either way.
      const { rawResult, countRaw, duration } = await this.runWithRole(
        project,
        projectId,
        opts?.rls,
        async (client, inTransaction) => {
          if (runId && userId) {
            const pid = await client.query('SELECT pg_backend_pid() AS pid');
            this.running.set(runId, { projectId, userId, pid: Number(pid.rows[0]?.pid) });
          }
          try {
            const t0 = Date.now();
            let main: QueryResult | QueryResult[];
            if (readOnly && !inTransaction) {
              await client.query('BEGIN READ ONLY');
              try {
                main = await client.query({ text: runQuery, values, rowMode: 'array' } as any);
                await client.query('COMMIT');
              } catch (e) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw e;
              }
            } else {
              if (readOnly) await client.query('SET TRANSACTION READ ONLY');
              main = await client.query({ text: runQuery, values, rowMode: 'array' } as any);
            }
            const dur = Date.now() - t0;
            const count = countSql ? await this.countRows(client, countSql, values, inTransaction) : null;
            return { rawResult: main, countRaw: count, duration: dur };
          } finally {
            if (runId) this.running.delete(runId);
          }
        },
      );

      // node-postgres returns an array of results for a multi-statement query.
      const allResults: QueryResult[] = Array.isArray(rawResult)
        ? (rawResult as QueryResult[])
        : [rawResult as QueryResult];
      // Each statement in a multi-statement script gets its own result set so
      // the UI can show every query's output, not just the last one.
      const resultSets = allResults.map((r) => toResultSet(r, resultCap));
      // Primary result (used for the toolbar/pagination of single queries): the
      // last statement that returned rows, falling back to the last statement.
      const primaryIndex = (() => {
        for (let i = allResults.length - 1; i >= 0; i--) {
          if (allResults[i].fields?.length) return i;
        }
        return allResults.length - 1;
      })();
      const primary: SqlResultSet = resultSets[primaryIndex] ?? { rows: [], rowCount: null };

      if (countRaw) {
        const raw = Number(countRaw.rows[0]?.total ?? 0);
        totalIsApprox = raw > 10000;
        total = totalIsApprox ? 10000 : raw;
      }

      const auditLog = await this.prisma.sqlAuditLog.create({
        data: {
          projectId,
          userId: userId || 'sdk',
          query,
          rowCount: primary.rowCount,
          duration,
        },
        select: { id: true },
      });

      // Asynchronously index the query for semantic search — fire and forget.
      // Only index non-trivial queries (>20 chars) to avoid noise.
      if (query.trim().length > 20) {
        const normalizedQuery = query
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/--[^\n]*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1000);

        this.embeddingService.enqueueJob(
          [{
            entityType: 'sql_audit_log',
            entityId: auditLog.id,
            content: normalizedQuery,
            projectId,
            teamId: project.teamId,
            extraMeta: { rowCount: primary.rowCount ?? null, duration },
          }],
          10, // low priority
          2000, // 2s delay — let the audit log settle first
        );
      }

      // Log every successful SQL execution. The Project logs page lives or
      // dies by this — previously only failures showed up, which made the
      // feed look misleadingly empty during normal heavy SQL usage.
      // `changes` tells open dashboard pages (the data editor) that this run
      // may have changed rows or tables, so they reload; a plain read does not.
      const changes = infos.some((info) => info.kind !== 'select');
      const qPreview = query.replace(/\s+/g, ' ').trim().slice(0, 240);
      await this.activity.append(projectId, {
        userId: userId || undefined,
        kind: ProjectActivityKind.SQL_EXECUTED,
        title:
          primary.rowCount != null
            ? `SQL executed (${primary.rowCount} ${primary.rowCount === 1 ? 'row' : 'rows'}, ${duration}ms)`
            : `SQL executed (${duration}ms)`,
        detail: `${qPreview}${query.length > 240 ? '…' : ''}`,
        metadata: { rowCount: primary.rowCount ?? null, duration },
        broadcast: { changes },
      });

      // A write made with an API key — the SDK's from() builder sends its
      // inserts, updates and deletes here — reaches realtime subscribers like a
      // REST write does. Only the builder's single-statement RETURNING * shape
      // is recognised; the SQL editor (no key) stays silent, as documented.
      if (opts?.rls && allResults.length === 1) {
        this.realtimeData?.publishSqlWrite(projectId, query, allResults[0].rows);
      }

      const truncated = resultSets.some((rs) => rs.truncated);
      return {
        rows: primary.rows,
        fields: primary.fields,
        rowCount: primary.rowCount,
        duration,
        page,
        limit,
        paginated: canPaginate,
        total,
        totalIsApprox,
        ...(truncated ? { truncated: true, maxRows: resultCap ?? null } : {}),
        resultSets: opts?.compact && resultSets.length <= 1 ? undefined : resultSets,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;

      await this.prisma.sqlAuditLog.create({
        data: {
          projectId,
          userId: userId || 'sdk',
          query,
          error: err.message,
          duration,
        },
      });

      const qPreview = query.replace(/\s+/g, ' ').trim().slice(0, 240);
      await this.activity.append(projectId, {
        userId: userId || undefined,
        kind: ProjectActivityKind.SQL_FAILED,
        title: 'SQL execution failed',
        detail: `${qPreview}${query.length > 240 ? '…' : ''} — ${err.message}`,
      });

      if (readOnly && err?.code === PG_READ_ONLY_TRANSACTION) {
        throw new BadRequestException(
          'This query changes data, so its other pages are not fetched by running it again. ' +
            'Run it again to see the first page, or add LIMIT and OFFSET to page through it yourself.',
        );
      }
      if (err?.code === '57014' && /user request/i.test(err?.message ?? '')) {
        throw new BadRequestException('SQL error: the query was cancelled.');
      }
      // The SQLSTATE travels as `code` (the exception filter forwards it), so
      // an SDK caller can tell a duplicate key from a policy denial without
      // parsing the message.
      const sqlMessage = `SQL error: ${isPgError(err) ? describePgError(err) : err.message}`;
      throw new BadRequestException(
        isPgError(err) ? { message: sqlMessage, code: err.code } : sqlMessage,
      );
    }
  }

  /**
   * The bounded count for a paged read. It runs the caller's statement a
   * second time, so it must never repeat a side effect: on its own connection
   * it runs in a read-only transaction that is rolled back, inside the RLS
   * transaction under a savepoint that is rolled back. A count that cannot run
   * that way is simply left out (total = null).
   */
  private async countRows(
    client: import('pg').PoolClient,
    countSql: string,
    values: unknown[] | undefined,
    inTransaction: boolean,
  ): Promise<QueryResult | null> {
    if (inTransaction) {
      await client.query('SAVEPOINT _bf_count');
      try {
        await client.query('SET TRANSACTION READ ONLY');
        return (await client.query(countSql, values)) as QueryResult;
      } catch {
        return null;
      } finally {
        // Rolling back also ends the read-only setting for the rest of the
        // transaction, and leaves the caller's own statement untouched.
        await client.query('ROLLBACK TO SAVEPOINT _bf_count').catch(() => undefined);
      }
    }
    try {
      await client.query('BEGIN READ ONLY');
      return (await client.query(countSql, values)) as QueryResult;
    } catch {
      return null;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  }

  /**
   * Cancel a statement this user started from the SQL editor with `runId`.
   * Uses its own short-lived connection, so a busy pool cannot hold it up.
   */
  async cancel(projectId: string, runId: string, userId: string) {
    const { project } = await this.loadProject(projectId, userId);
    const run = this.running.get(runId);
    if (!run || run.projectId !== projectId || run.userId !== userId) {
      return { cancelled: false };
    }
    const client = new Client({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 5_000,
    });
    try {
      await client.connect();
      const r = await client.query('SELECT pg_cancel_backend($1) AS ok', [run.pid]);
      return { cancelled: Boolean(r.rows[0]?.ok) };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** The signed-in user's recent statements in this project, newest first. */
  async history(projectId: string, userId: string, limit = 50) {
    await this.loadProject(projectId, userId);
    const take = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
    return this.prisma.sqlAuditLog.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        query: true,
        error: true,
        rowCount: true,
        duration: true,
        createdAt: true,
      },
    });
  }

  // ── Saved queries ─────────────────────────────────────────────────────────

  async listSnippets(projectId: string, userId: string) {
    await this.loadProject(projectId, userId);
    return this.prisma.sqlSnippet.findMany({
      where: { projectId },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createSnippet(projectId: string, userId: string, body: { name: string; query: string }) {
    await this.loadProject(projectId, userId);
    const { name, query } = this.snippetFields(body, true);
    return this.prisma.sqlSnippet.create({
      data: { projectId, userId, name: name!, query: query! },
    });
  }

  async updateSnippet(id: string, userId: string, body: { name?: string; query?: string }) {
    const snippet = await this.editableSnippet(id, userId);
    const fields = this.snippetFields(body, false);
    return this.prisma.sqlSnippet.update({
      where: { id: snippet.id },
      data: fields,
    });
  }

  async deleteSnippet(id: string, userId: string) {
    const snippet = await this.editableSnippet(id, userId);
    await this.prisma.sqlSnippet.delete({ where: { id: snippet.id } });
    return { deleted: true };
  }

  /** A snippet its author, or an owner/admin of the project's team, may change. */
  private async editableSnippet(id: string, userId: string) {
    const snippet = await this.prisma.sqlSnippet.findUnique({ where: { id } });
    if (!snippet) throw new NotFoundException('Saved query not found');
    const { membership } = await this.loadProject(snippet.projectId, userId);
    const role = (membership as { role?: string } | null)?.role;
    if (snippet.userId !== userId && role !== 'OWNER' && role !== 'ADMIN') {
      throw new ForbiddenException('Only its author or a team owner/admin can change this saved query');
    }
    return snippet;
  }

  private snippetFields(body: { name?: unknown; query?: unknown }, required: boolean) {
    const out: { name?: string; query?: string } = {};
    if (body?.name !== undefined || required) {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) throw new BadRequestException('A name is required');
      if (name.length > 120) throw new BadRequestException('The name must be at most 120 characters');
      out.name = name;
    }
    if (body?.query !== undefined || required) {
      const query = typeof body?.query === 'string' ? body.query : '';
      if (!query.trim()) throw new BadRequestException('The query is empty');
      if (query.length > 100_000) throw new BadRequestException('The query is longer than 100,000 characters');
      out.query = query;
    }
    return out;
  }

  /**
   * Run `fn` against the project database under the right authority.
   *
   * With no RLS context the caller is a dashboard team member: the statement
   * runs as the database owner, on a pooled connection, with no transaction —
   * byte for byte what the SQL editor did before.
   *
   * With an RLS context the caller authenticated by API key. The work runs in a
   * transaction that first switches to the key's role and publishes the JWT
   * claims policies read, so RLS governs the statement. Owner access is never
   * the fallback: if the role switch fails because this project predates the
   * grants, the project is bootstrapped once and the transaction retried; a
   * second failure is surfaced, never downgraded to owner.
   *
   * `fn` is told whether it runs inside that transaction.
   */
  private async runWithRole<T>(
    project: {
      id: string;
      dbHost: string;
      dbPort: number;
      dbUser: string;
      dbPassword: string;
      dbName: string;
    },
    projectId: string,
    rls: SqlRlsContext | undefined,
    fn: (client: import('pg').PoolClient, inTransaction: boolean) => Promise<T>,
  ): Promise<T> {
    const pool = this.getPool(project);

    if (!rls) {
      const client = await pool.connect();
      try {
        return await fn(client, false);
      } finally {
        client.release();
      }
    }

    const attempt = async (): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL ROLE "${rls.role}"`);
        } catch (roleErr: any) {
          if (roleErr && typeof roleErr === 'object') roleErr.__setRoleFailed = true;
          throw roleErr;
        }
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          rls.jwtClaims ? JSON.stringify(rls.jwtClaims) : '{}',
        ]);
        await client.query(`SELECT set_config('request.jwt.role', $1, true)`, [
          rls.role,
        ]);
        // Single-claim keys for helpers written against request.jwt.claim.<name>
        // (imported schemas); see jwt-claim-settings.ts.
        for (const [key, value] of jwtClaimSettings(rls.role, rls.jwtClaims)) {
          await client.query(`SELECT set_config($1, $2, true)`, [key, value]);
        }
        const out = await fn(client, true);
        await client.query('COMMIT');
        return out;
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
    };

    try {
      return await attempt();
    } catch (err: any) {
      // Only a failed SET ROLE means the project is missing the role grants and
      // can be healed. A query-level privilege error (the role is in place but
      // the statement is not allowed — e.g. the anon key attempting a write)
      // must surface as itself, not trigger a bootstrap loop.
      if (!(err?.code === PG_INSUFFICIENT_PRIVILEGE && err.__setRoleFailed)) {
        throw err;
      }
      this.logger.warn(
        `SET ROLE "${rls.role}" denied for project ${projectId}; bootstrapping RLS and retrying once.`,
      );
      await this.projectsService.ensureRlsBootstrap(projectId);
      return await attempt();
    }
  }

  private validateQuery(query: string, role: SqlCallerRole) {
    const pattern = findForbiddenSqlPattern(query, role);
    if (pattern) {
      throw new BadRequestException(
        role === 'owner' || role === 'service_role'
          ? `Forbidden SQL operation: ${pattern}`
          : `Forbidden SQL operation: ${pattern}. Schema and policy changes need the service key and must be made from your server, not over the anon key.`,
      );
    }
  }
}
