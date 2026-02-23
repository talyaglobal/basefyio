import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';

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
  ) {}

  async execute(projectId: string, query: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership) {
      throw new NotFoundException('Project not found');
    }

    this.validateQuery(query);

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
      const result = await client.query(query);
      const duration = Date.now() - startTime;

      await this.prisma.sqlAuditLog.create({
        data: {
          projectId,
          userId,
          query,
          rowCount: result.rowCount,
          duration,
        },
      });

      return {
        rows: result.rows,
        fields: result.fields?.map((f) => ({
          name: f.name,
          dataTypeId: f.dataTypeID,
        })),
        rowCount: result.rowCount,
        duration,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;

      await this.prisma.sqlAuditLog.create({
        data: {
          projectId,
          userId,
          query,
          error: err.message,
          duration,
        },
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
