import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { Pool } from 'pg';

export interface AskResult {
  question: string;
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  chartHint: 'table' | 'bar' | 'line' | 'pie';
  rowCount: number;
}

const UNSAFE_SQL_PATTERN =
  /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|ANALYZE)\b/i;

@Injectable()
export class IntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly config: ConfigService,
  ) {}

  async ask(userId: string, projectId: string, question: string): Promise<AskResult> {
    // 1. Load project
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');

    // 2. Load entities (semantic layer)
    const entities: Array<{
      entityName: string;
      tableName: string;
      description: string;
      metadata: unknown;
    }> = await (this.prisma as any).appEntity.findMany({ where: { projectId } });

    if (entities.length === 0) {
      throw new BadRequestException(
        'No entities found for this project. Run /generate first.',
      );
    }

    // 3. Build schema context for the AI prompt
    const schemaContext = entities
      .map((e) => {
        const meta = e.metadata as Record<string, unknown>;
        const ddl = meta?.ddl ? `\n${meta.ddl}` : '';
        return `-- ${e.entityName} (table: ${e.tableName})\n${ddl}`;
      })
      .join('\n\n');

    // 4. Call AI to generate SQL
    const sql = await this.generateSQL(question, schemaContext);

    // 5. Safety validation
    if (UNSAFE_SQL_PATTERN.test(sql)) {
      throw new BadRequestException('Generated SQL contains unsafe operations');
    }

    // 6. Execute query
    const { rows, columns } = await this.executeQuery(project as any, sql);

    // 7. Detect chart hint
    const chartHint = this.detectChartHint(columns, rows);

    return { question, sql, columns, rows, chartHint, rowCount: rows.length };
  }

  private async generateSQL(question: string, schemaContext: string): Promise<string> {
    const prompt = `You are a SQL expert. Given the following database schema, generate a single safe SELECT query to answer the user's question.

Schema:
${schemaContext}

Rules:
- Return ONLY the SQL query, nothing else
- Only use SELECT statements
- Add LIMIT 100 if no limit is specified
- Use proper column aliases for readability
- Do not include explanations or markdown

Question: ${question}`;

    const response = await this.ai.complete(prompt);
    return response
      .trim()
      .replace(/^```sql\n?/, '')
      .replace(/\n?```$/, '');
  }

  private async executeQuery(
    project: {
      dbHost: string;
      dbPort: number;
      dbName: string;
      dbUser: string;
      dbPassword: string;
    },
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      database: project.dbName,
      user: project.dbUser,
      password: project.dbPassword,
      statement_timeout: 5000,
      max: 1,
    });

    try {
      const result = await pool.query(sql);
      const columns = result.fields.map((f) => f.name);
      return { rows: result.rows, columns };
    } finally {
      await pool.end();
    }
  }

  detectChartHint(
    columns: string[],
    rows: Record<string, unknown>[],
  ): 'table' | 'bar' | 'line' | 'pie' {
    if (columns.length !== 2 || rows.length === 0) return 'table';
    const firstColName = columns[0].toLowerCase();
    const secondVal = rows[0][columns[1]];
    const isNumericSecond =
      typeof secondVal === 'number' || !isNaN(Number(secondVal));
    if (!isNumericSecond) return 'table';
    if (/date|time|month|year|day/.test(firstColName)) return 'line';
    if (/category|type|status|name|label/.test(firstColName)) return 'bar';
    return 'bar';
  }
}
