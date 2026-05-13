import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
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

    // Server-side pagination — protects both the UI and the API from
    // multi-million-row result sets. Only applies to SELECT-shape queries;
    // everything else (INSERT/UPDATE/DELETE/DDL) runs raw because those
    // don't return scrollable rowsets the user would page through.
    //
    // We detect "is this a SELECT?" by parsing the leading token after
    // stripping comments + leading WITH ... CTEs. WITH expressions are
    // explicitly allowed because they end in a SELECT and behave
    // identically pagination-wise.
    const trimmed = query.replace(/--[^\n]*/g, '').trim();
    const leading = trimmed.toUpperCase();
    const isSelectShape = leading.startsWith('SELECT') || leading.startsWith('WITH');

    const page = Math.max(1, opts?.page ?? 1);
    const limit = Math.min(Math.max(1, opts?.limit ?? 100), 1000);
    const offset = (page - 1) * limit;

    // Build the actual SQL we'll run. For SELECT, wrap as a subquery and
    // attach LIMIT/OFFSET. The subquery preserves the user's ORDER BY (if
    // any) so pagination is stable; without an ORDER BY the database is
    // free to return rows in any order, which is the user's responsibility
    // to fix in their query.
    //
    // Strip a trailing semicolon so it doesn't end up in the middle of our
    // generated wrapper. We only ever execute one statement.
    const stripped = query.replace(/;\s*$/, '');
    let runQuery: string;
    let total: number | null = null;
    let totalIsApprox = false;

    if (isSelectShape) {
      runQuery = `SELECT * FROM (${stripped}) AS _kb_paged LIMIT ${limit} OFFSET ${offset}`;
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
      const result = await client.query(runQuery);
      const duration = Date.now() - startTime;

      // For SELECT-shape queries: if the caller asked for a total count
      // (countTotal=true on page 1 only, by convention), run a bounded
      // COUNT against the same subquery. We cap at 10k matches so a
      // SELECT * FROM huge_table doesn't take 30s to count.
      if (isSelectShape && opts?.countTotal) {
        try {
          const countSql = `SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM (${stripped}) AS _kb_paged_count LIMIT 10001) sub`;
          const c = await client.query(countSql);
          const raw = Number(c.rows[0]?.total ?? 0);
          totalIsApprox = raw > 10000;
          total = totalIsApprox ? 10000 : raw;
        } catch {
          // COUNT can fail on queries that lock or have side effects in
          // weird ways; degrade gracefully — UI shows "Many rows" instead.
          total = null;
        }
      }

      await this.prisma.sqlAuditLog.create({
        data: {
          projectId,
          userId: userId || 'sdk',
          query,
          rowCount: result.rowCount,
          duration,
        },
      });

      // Audit-log every successful SQL execution.
      const qPreview = query.replace(/\s+/g, ' ').trim().slice(0, 240);
      await this.activity.append(projectId, {
        userId: userId || undefined,
        kind: ProjectActivityKind.SQL_EXECUTED,
        title:
          result.rowCount != null
            ? `SQL executed (${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}, ${duration}ms)`
            : `SQL executed (${duration}ms)`,
        detail: `${qPreview}${query.length > 240 ? '…' : ''}`,
        metadata: { rowCount: result.rowCount ?? null, duration, page, limit },
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
        paginated: isSelectShape,
        total,
        totalIsApprox,
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

  private validateQuery(query: string) {
    const upper = query.toUpperCase().trim();

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (upper.includes(pattern)) {
        throw new BadRequestException(
          `Forbidden SQL operation: ${pattern}`,
        );
      }
    }
  }
}
