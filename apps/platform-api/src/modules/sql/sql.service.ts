import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Pool, QueryResult } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { ProjectsService } from '../projects/projects.service';
import { findForbiddenSqlPattern } from './sql-guard';

/** Postgres "insufficient_privilege" — SET LOCAL ROLE raises this when the
 *  connecting db user was never granted membership in the target role. */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

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
  ) {}

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
    },
  ) {
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
    }

    this.validateQuery(query);

    // Bound values are never part of the statement, so `validateQuery` never
    // sees them — which is the point rather than a gap. The guard scans the SQL
    // that will run, literals included, because a literal is where a smuggled
    // COPY would hide; the cost was that an ordinary value written into the SQL
    // ("page load", "grant access") was refused as the operation it names.
    // Sent apart, a value cannot be read as an operation and cannot become
    // syntax. Every character of the statement is still scanned.
    const values = opts?.params?.length ? opts.params : undefined;

    const trimmed = query.replace(/--[^\n]*/g, '').trim();
    const leading = trimmed.toUpperCase();
    const isSelectShape = leading.startsWith('SELECT') || leading.startsWith('WITH');
    const page = Math.max(1, opts?.page ?? 1);
    const limit = Math.min(Math.max(1, opts?.limit ?? 100), 1000);
    const offset = (page - 1) * limit;
    const stripped = query.replace(/;\s*$/, '');
    // Pagination wraps the query in a subselect, which only works for a single
    // SELECT. A multi-statement script (e.g. "CREATE TEMP ...; SELECT ...;")
    // must run as-is — we then surface the last result that returns rows.
    const multi = this.isMultiStatement(query);

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

    const canPaginate = isSelectShape && !multi;
    let runQuery: string;
    let total: number | null = null;
    let totalIsApprox = false;
    if (canPaginate) {
      runQuery = `SELECT * FROM (${stripped}) AS _bf_paged LIMIT ${limit} OFFSET ${offset}`;
    } else {
      runQuery = query;
    }

    const startTime = Date.now();
    const countSql =
      canPaginate && opts?.countTotal
        ? `SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM (${stripped}) AS _bf_paged_count LIMIT 10001) sub`
        : null;

    try {
      // A dashboard editor runs as owner; an API-key caller runs under its DB
      // role so RLS applies. runWithRole owns the connection either way.
      const { rawResult, countRaw, duration } = await this.runWithRole(
        project,
        projectId,
        opts?.rls,
        async (client) => {
          const t0 = Date.now();
          const main = await client.query(runQuery, values);
          const dur = Date.now() - t0;
          let count: QueryResult | null = null;
          if (countSql) {
            try {
              // The count wraps the same statement, so it carries the same
              // placeholders.
              count = (await client.query(countSql, values)) as QueryResult;
            } catch {
              count = null;
            }
          }
          return { rawResult: main, countRaw: count, duration: dur };
        },
      );

      // node-postgres returns an array of results for a multi-statement query.
      // Show the last statement that returned rows (the final SELECT); fall back
      // to the last statement so non-SELECT scripts still report success.
      const allResults: QueryResult[] = Array.isArray(rawResult)
        ? (rawResult as QueryResult[])
        : [rawResult as QueryResult];
      // Each statement in a multi-statement script gets its own result set so
      // the UI can show every query's output, not just the last one.
      const resultSets = allResults.map((r) => ({
        fields: r.fields?.map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
        rows: r.rows,
        rowCount: r.rowCount,
      }));
      // Primary result (used for the toolbar/pagination of single queries): the
      // last statement that returned rows, falling back to the last statement.
      const result: QueryResult =
        allResults.slice().reverse().find((r) => r.fields?.length) ??
        allResults[allResults.length - 1];

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
          rowCount: result.rowCount,
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
            extraMeta: { rowCount: result.rowCount ?? null, duration },
          }],
          10, // low priority
          2000, // 2s delay — let the audit log settle first
        );
      }

      // Log every successful SQL execution. The Project logs page lives or
      // dies by this — previously only failures showed up, which made the
      // feed look misleadingly empty during normal heavy SQL usage.
      const qPreview = query.replace(/\s+/g, ' ').trim().slice(0, 240);
      await this.activity.append(projectId, {
        userId: userId || undefined,
        kind: ProjectActivityKind.SQL_EXECUTED,
        title:
          result.rowCount != null
            ? `SQL executed (${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}, ${duration}ms)`
            : `SQL executed (${duration}ms)`,
        detail: `${qPreview}${query.length > 240 ? '…' : ''}`,
        metadata: { rowCount: result.rowCount ?? null, duration },
      });

      return {
        rows: result.rows,
        fields: result.fields?.map((f) => ({
          name: f.name,
          dataTypeId: f.dataTypeID,
        })),
        rowCount: result.rowCount,
        duration,
        page,
        limit,
        paginated: canPaginate,
        total,
        totalIsApprox,
        resultSets,
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

      throw new BadRequestException(`SQL error: ${err.message}`);
    }
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
    fn: (client: import('pg').PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = this.getPool(project);

    if (!rls) {
      const client = await pool.connect();
      try {
        return await fn(client);
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
        const out = await fn(client);
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

  /**
   * Best-effort detection of a multi-statement script: strip comments, string
   * literals and dollar-quoted blocks, then look for a semicolon before the end.
   */
  private isMultiStatement(query: string): boolean {
    let s = query
      .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
      .replace(/--[^\n]*/g, ' '); // line comments
    s = s.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, ' '); // dollar-quoted
    s = s.replace(/'(?:[^']|'')*'/g, ' '); // single-quoted strings
    s = s.replace(/"(?:[^"]|"")*"/g, ' '); // quoted identifiers
    s = s.replace(/;\s*$/g, '').trim(); // drop trailing semicolon(s)
    return s.includes(';');
  }

  private validateQuery(query: string) {
    const pattern = findForbiddenSqlPattern(query);
    if (pattern) {
      throw new BadRequestException(`Forbidden SQL operation: ${pattern}`);
    }
  }
}
