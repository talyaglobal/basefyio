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

      if (isSelectShape && opts?.countTotal) {
        try {
          const countSql = `SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM (${stripped}) AS _kb_paged_count LIMIT 10001) sub`;
          const c = await client.query(countSql);
          const raw = Number(c.rows[0]?.total ?? 0);
          totalIsApprox = raw > 10000;
          total = totalIsApprox ? 10000 : raw;
        } catch {
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
