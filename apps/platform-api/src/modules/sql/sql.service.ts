import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResult } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';

const FORBIDDEN_PATTERNS = [
  'DROP DATABASE',
  'DROP ROLE',
  'CREATE ROLE',
  'ALTER ROLE',
  'CREATE DATABASE',
  'COPY ',
  'pg_read_file',
  'pg_write_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'lo_import',
  'lo_export',
  'CREATE EXTENSION',
  'LOAD ',
  'SET ROLE',
  'SET SESSION AUTHORIZATION',
  'GRANT ',
  'REVOKE ',
  'CREATE USER',
  'ALTER USER',
  'DROP USER',
  'CREATE TABLESPACE',
  'ALTER SYSTEM',
];

@Injectable()
export class SqlService {
  private readonly logger = new Logger(SqlService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly activity: ProjectActivityService,
  ) {}

  async execute(
    projectId: string,
    query: string,
    userId?: string,
    opts?: { page?: number; limit?: number; countTotal?: boolean },
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
    const canPaginate = isSelectShape && !multi;
    let runQuery: string;
    let total: number | null = null;
    let totalIsApprox = false;
    if (canPaginate) {
      runQuery = `SELECT * FROM (${stripped}) AS _bf_paged LIMIT ${limit} OFFSET ${offset}`;
    } else {
      runQuery = query;
    }

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 30_000,
    });

    const startTime = Date.now();
    const client = await pool.connect();

    try {
      const rawResult = await client.query(runQuery);
      const duration = Date.now() - startTime;

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

      if (canPaginate && opts?.countTotal) {
        try {
          const countSql = `SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM (${stripped}) AS _bf_paged_count LIMIT 10001) sub`;
          const c = await client.query(countSql);
          const raw = Number(c.rows[0]?.total ?? 0);
          totalIsApprox = raw > 10000;
          total = totalIsApprox ? 10000 : raw;
        } catch {
          total = null;
        }
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
    } finally {
      client.release();
      await pool.end();
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
    // Strip comments to prevent pattern bypass via /* DROP DATABASE */
    const stripped = query
      .replace(/\/\*[\s\S]*?\*\//g, ' ')  // block comments
      .replace(/--[^\n]*/g, ' ')            // line comments
      .replace(/\s+/g, ' ')                 // normalize whitespace
      .toUpperCase()
      .trim();

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (stripped.includes(pattern)) {
        throw new BadRequestException(
          `Forbidden SQL operation: ${pattern}`,
        );
      }
    }
  }
}
