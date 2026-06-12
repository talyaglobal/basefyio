import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { diffDataModels } from '@basefyio/blueprint';
import { generateMigrationSQL } from '../blueprint/lib/migration-sql';
import type { DataModel, MigrationPlan } from '@basefyio/blueprint';

export interface PlanResult {
  migrationRunId: string;
  plan: MigrationPlan;
  sqlStatements: string[];
  fromVersion: number;
  toVersion: number;
}

export interface ApplyResult {
  migrationRunId: string;
  status: 'APPLIED' | 'FAILED';
  appliedStatements: number;
  errorMessage?: string;
}

@Injectable()
export class MigrationsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getProject(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  private async getPool(projectId: string) {
    const project = await this.getProject(projectId);
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      database: project.dbName,
      user: project.dbUser,
      password: project.dbPassword,
      max: 1,
      statement_timeout: 30_000,
    });
    return { pool, project };
  }

  private async getLatestApprovedVersions(projectId: string) {
    const versions = await (this.prisma as any).applicationVersion.findMany({
      where: { blueprint: { projectId } },
      include: { blueprint: { select: { projectId: true } } },
      orderBy: { version: 'desc' },
      take: 2,
    });
    return versions as Array<{
      id: string;
      version: number;
      dataModel: unknown;
      blueprint: { projectId: string };
    }>;
  }

  async plan(projectId: string, fromVersion?: number, toVersion?: number): Promise<PlanResult> {
    await this.getProject(projectId);

    const versions = await this.getLatestApprovedVersions(projectId);
    if (versions.length < 2) {
      throw new BadRequestException(
        'Need at least two blueprint versions to generate a migration plan',
      );
    }

    const sorted = [...versions].sort((a, b) => a.version - b.version);
    const from = fromVersion
      ? sorted.find(v => v.version === fromVersion)
      : sorted[sorted.length - 2];
    const to = toVersion
      ? sorted.find(v => v.version === toVersion)
      : sorted[sorted.length - 1];

    if (!from) throw new BadRequestException(`Blueprint version ${fromVersion} not found`);
    if (!to) throw new BadRequestException(`Blueprint version ${toVersion} not found`);
    if (from.version >= to.version) {
      throw new BadRequestException('fromVersion must be less than toVersion');
    }

    const v1 = from.dataModel as DataModel;
    const v2 = to.dataModel as DataModel;

    const plan = diffDataModels(v1, v2);
    const sqlStatements = generateMigrationSQL(plan, v1, v2);

    const run = await (this.prisma as any).migrationRun.create({
      data: {
        projectId,
        fromBlueprintVersion: from.version,
        toBlueprintVersion: to.version,
        status: 'PENDING',
        planJson: plan as any,
        sqlStatements: sqlStatements as any,
      },
    });

    return {
      migrationRunId: run.id,
      plan,
      sqlStatements,
      fromVersion: from.version,
      toVersion: to.version,
    };
  }

  async apply(
    projectId: string,
    migrationRunId: string,
    force = false,
  ): Promise<ApplyResult> {
    const run = await (this.prisma as any).migrationRun.findFirst({
      where: { id: migrationRunId, projectId },
    });
    if (!run) throw new NotFoundException('Migration run not found');
    if (run.status === 'APPLIED') throw new ConflictException('Migration already applied');
    if (run.status === 'APPLYING') throw new ConflictException('Migration is already in progress');

    const plan = run.planJson as MigrationPlan;
    if (plan.hasDestructive && !force) {
      throw new BadRequestException(
        `Migration contains destructive changes: [${plan.breakingChanges.join(', ')}]. ` +
          'Pass force=true to apply anyway.',
      );
    }

    await (this.prisma as any).migrationRun.update({
      where: { id: migrationRunId },
      data: { status: 'APPLYING', startedAt: new Date() },
    });

    const { pool } = await this.getPool(projectId);
    const statements = run.sqlStatements as string[];
    let appliedStatements = 0;

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const sql of statements) {
          await client.query(sql);
          appliedStatements++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await (this.prisma as any).migrationRun.update({
        where: { id: migrationRunId },
        data: {
          status: 'APPLIED',
          appliedStatements,
          completedAt: new Date(),
        },
      });

      return { migrationRunId, status: 'APPLIED', appliedStatements };
    } catch (err: any) {
      await (this.prisma as any).migrationRun.update({
        where: { id: migrationRunId },
        data: {
          status: 'FAILED',
          appliedStatements,
          errorMessage: err.message?.slice(0, 2000),
          completedAt: new Date(),
        },
      });
      return {
        migrationRunId,
        status: 'FAILED',
        appliedStatements,
        errorMessage: err.message,
      };
    } finally {
      await pool.end();
    }
  }

  async list(projectId: string) {
    await this.getProject(projectId);
    const runs = await (this.prisma as any).migrationRun.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return runs as Array<{
      id: string;
      fromBlueprintVersion: number;
      toBlueprintVersion: number;
      status: string;
      appliedStatements: number;
      errorMessage: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      createdAt: Date;
    }>;
  }

  async get(projectId: string, migrationRunId: string) {
    const run = await (this.prisma as any).migrationRun.findFirst({
      where: { id: migrationRunId, projectId },
    });
    if (!run) throw new NotFoundException('Migration run not found');
    return run;
  }
}
