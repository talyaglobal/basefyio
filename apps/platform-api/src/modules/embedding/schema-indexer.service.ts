import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import type { EmbedJob } from './types';

interface ProjectDb {
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  teamId: string;
}

@Injectable()
export class SchemaIndexerService {
  private readonly logger = new Logger(SchemaIndexerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Index all public tables of a project's database.
   * Each table becomes one embedding chunk:
   *   "table_name: col1 type, col2 type, ..."
   *
   * Called after project creation and after table create/drop events.
   * Fire-and-forget — never throws.
   */
  async indexProjectSchema(projectId: string): Promise<void> {
    try {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, status: 'ACTIVE' },
        select: {
          dbHost: true,
          dbPort: true,
          dbUser: true,
          dbPassword: true,
          dbName: true,
          teamId: true,
        },
      });

      if (!project) return;

      const tables = await this.fetchSchema(project);
      if (tables.length === 0) return;

      const jobs: EmbedJob[] = tables.map(({ tableName, columns }) => ({
        entityType: 'project_schema' as const,
        entityId: `${projectId}:${tableName}`,
        content: `${tableName}: ${columns}`,
        projectId,
        teamId: project.teamId,
        extraMeta: { tableName, projectId },
      }));

      this.embeddingService.enqueueJob(jobs, 5, 3000);
    } catch (err: any) {
      this.logger.warn(
        `Schema indexing failed for project ${projectId}: ${err?.message}`,
      );
    }
  }

  private async fetchSchema(
    project: ProjectDb,
  ): Promise<Array<{ tableName: string; columns: string }>> {
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 10_000,
      connectionTimeoutMillis: 5_000,
    });

    const client = await pool.connect();
    try {
      const result = await client.query<{
        table_name: string;
        columns: string;
      }>(`
        SELECT
          t.table_name,
          string_agg(
            c.column_name || ' ' || c.data_type,
            ', '
            ORDER BY c.ordinal_position
          ) AS columns
        FROM information_schema.tables t
        JOIN information_schema.columns c
          ON c.table_schema = t.table_schema
          AND c.table_name = t.table_name
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
        GROUP BY t.table_name
        ORDER BY t.table_name
        LIMIT 200
      `);

      return result.rows.map((r) => ({
        tableName: r.table_name,
        columns: r.columns ?? '',
      }));
    } finally {
      client.release();
      await pool.end();
    }
  }
}
