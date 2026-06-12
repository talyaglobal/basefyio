import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { compileRLS } from '../blueprint/lib/rls-compiler';
import { Pool } from 'pg';

export interface PolicyCompileResult {
  projectId: string;
  tablesAffected: string[];
  statementsExecuted: number;
  errors: string[];
}

@Injectable()
export class PolicyCompilerService {
  private readonly logger = new Logger(PolicyCompilerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compile and apply RLS policies for a project's blueprint.
   * Reads the latest ApplicationVersion for the project's blueprint,
   * extracts roles/permissions, generates RLS SQL, and applies it.
   *
   * Safe to call multiple times (policies are CREATE OR REPLACE where possible,
   * or DROP + CREATE with error tolerance per policy).
   */
  async applyPolicies(projectId: string): Promise<PolicyCompileResult> {
    // 1. Load blueprint for the project
    const blueprint = await (this.prisma as any).blueprint.findFirst({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
    });

    if (!blueprint) {
      return { projectId, tablesAffected: [], statementsExecuted: 0, errors: ['No blueprint found for project'] };
    }

    // 2. Load current ApplicationVersion
    const version = blueprint.currentVersionId
      ? await (this.prisma as any).applicationVersion.findUnique({ where: { id: blueprint.currentVersionId } })
      : null;

    const appModel = (version?.applicationModel ?? {}) as {
      roles?: Array<{ name: string; permissions: Record<string, string[]> }>;
    };
    const roles = appModel.roles ?? [];

    // 3. Load AppEntity rows to get table names
    const entities: Array<{ tableName: string }> = await (this.prisma as any).appEntity.findMany({
      where: { projectId },
      select: { tableName: true },
    });
    const tableNames = entities.map((e) => e.tableName);

    if (tableNames.length === 0 || roles.length === 0) {
      return { projectId, tablesAffected: [], statementsExecuted: 0, errors: ['No tables or roles to compile'] };
    }

    // 4. Generate RLS SQL
    const statements = compileRLS(tableNames, roles);

    // 5. Load project DB connection
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) {
      return { projectId, tablesAffected: tableNames, statementsExecuted: 0, errors: ['Project not found'] };
    }

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      database: project.dbName,
      user: project.dbUser,
      password: project.dbPassword,
      statement_timeout: 10_000,
      max: 1,
    });

    const errors: string[] = [];
    let statementsExecuted = 0;

    // 6. Execute statements — best-effort per statement
    const client = await pool.connect();
    try {
      for (const stmt of statements) {
        try {
          await client.query(stmt);
          statementsExecuted++;
        } catch (err: any) {
          // Policy already exists → try DROP + re-CREATE
          const msg: string = err?.message ?? String(err);
          if (msg.includes('already exists')) {
            // Extract policy name and table from statement, attempt DROP
            const policyMatch = stmt.match(/"([^"]+_[^"]+_(?:select|insert|update|delete))"/);
            const tableMatch = stmt.match(/ON "([^"]+)"/);
            if (policyMatch && tableMatch) {
              try {
                await client.query(`DROP POLICY IF EXISTS "${policyMatch[1]}" ON "${tableMatch[1]}"`);
                await client.query(stmt);
                statementsExecuted++;
              } catch (dropErr: any) {
                errors.push(`${stmt.slice(0, 60)}: ${dropErr?.message}`);
              }
            }
          } else {
            errors.push(`${stmt.slice(0, 60)}: ${msg}`);
          }
          this.logger.warn(`RLS statement failed: ${msg}`);
        }
      }
    } finally {
      client.release();
      await pool.end();
    }

    return { projectId, tablesAffected: tableNames, statementsExecuted, errors };
  }
}
