import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  ToolAdapter,
  ToolAdapterContext,
  ToolAdapterResult,
} from './tool-adapter.interface';

const MAX_ROWS = 200;
const QUERY_TIMEOUT_MS = 10_000;

// Patterns that indicate a mutating statement — blocked unconditionally.
const MUTATING_PATTERN =
  /^\s*(insert|update|delete|truncate|drop|create|alter|grant|revoke|copy|vacuum|analyze|reindex|cluster|comment|security|set\s+role|reset\s+role)/i;

@Injectable()
export class SqlExecutorAdapter implements ToolAdapter {
  readonly toolId = 'sql_executor';
  private readonly logger = new Logger(SqlExecutorAdapter.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolAdapterContext,
  ): Promise<ToolAdapterResult> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) {
      return { output: { rows: [], error: 'query is required' } };
    }

    if (MUTATING_PATTERN.test(query)) {
      return {
        output: {
          rows: [],
          error: 'Mutating SQL is not allowed via the sql_executor tool.',
        },
      };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: ctx.projectId, status: 'ACTIVE' },
      select: {
        dbHost: true,
        dbPort: true,
        dbUser: true,
        dbPassword: true,
        dbName: true,
      },
    });

    if (!project?.dbHost) {
      return { output: { rows: [], error: 'Project database not provisioned.' } };
    }

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort ?? 5432,
      user: project.dbUser ?? undefined,
      password: project.dbPassword ?? undefined,
      database: project.dbName ?? undefined,
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: QUERY_TIMEOUT_MS,
    } as ConstructorParameters<typeof Pool>[0]);

    try {
      const client = await pool.connect();
      try {
        // Run in read-only transaction to prevent accidental writes.
        await client.query('BEGIN READ ONLY');
        const result = await client.query(query);
        await client.query('COMMIT');

        const rows = result.rows.slice(0, MAX_ROWS);
        const truncated = result.rows.length > MAX_ROWS;

        this.logger.log(
          `sql_executor: ${rows.length} rows for run ${ctx.runId} (truncated=${truncated})`,
        );

        return {
          output: { rows, truncated, rowCount: rows.length },
          attachments: [
            {
              kind: 'sql_result',
              content: { query, rows, truncated, rowCount: rows.length },
            },
          ],
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sql_executor failed for run ${ctx.runId}: ${msg}`);
      return { output: { rows: [], error: msg } };
    } finally {
      await pool.end().catch(() => {});
    }
  }
}
