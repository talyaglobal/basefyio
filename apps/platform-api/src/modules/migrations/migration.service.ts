import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BlueprintService } from '../blueprint/blueprint.service';
import { CollectionService } from '../projects/collection.service';
import { DataModel } from '../blueprint/blueprint.types';
import { diffDataModels, MigrationPlan } from './migration-diff';

/**
 * Schema migrations for a Blueprint's generated tables: diff the last-generated
 * data model against the current one, compile a plan, and apply it to the
 * project DB (destructive changes require an explicit force flag).
 * Re-implemented from the askin migrations concept, our patterns, no code copied.
 */
@Injectable()
export class MigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blueprints: BlueprintService,
    private readonly collections: CollectionService,
  ) {}

  /** Build (and persist) a migration plan from the blueprint's pending changes. */
  async plan(blueprintId: string, userId?: string) {
    const blueprint = await this.blueprints.get(blueprintId, userId); // access check
    const projectId = blueprint.projectId;
    if (!projectId) {
      throw new BadRequestException('Blueprint has no target project; generate it first');
    }
    const from = (blueprint.generatedDataModel as unknown as DataModel) ?? { tables: [] };
    const to = blueprint.dataModel as unknown as DataModel;
    const plan = diffDataModels(from, to);

    return this.prisma.migrationRun.create({
      data: {
        blueprintId,
        projectId,
        status: 'PENDING',
        plan: plan as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async list(blueprintId: string, userId?: string) {
    await this.blueprints.get(blueprintId, userId); // access check
    return this.prisma.migrationRun.findMany({
      where: { blueprintId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async get(runId: string, userId?: string) {
    const run = await this.prisma.migrationRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Migration run not found');
    await this.blueprints.get(run.blueprintId, userId); // access check
    return run;
  }

  /** Apply a pending plan: create new tables, run ALTER/DROP statements. */
  async apply(runId: string, force: boolean, userId?: string) {
    const run = await this.get(runId, userId);
    if (run.status !== 'PENDING') {
      throw new BadRequestException(`Migration is already ${run.status.toLowerCase()}`);
    }
    const plan = run.plan as unknown as MigrationPlan;
    if (plan.hasDestructive && !force) {
      throw new ForbiddenException(
        'This migration contains destructive changes; re-run with force=true to apply',
      );
    }

    try {
      let applied = 0;
      // New tables (with grants + RLS) via the shared helper.
      for (const table of plan.newTables ?? []) {
        const columns = table.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
        }));
        // migration-diff PG types are logical; createRelationalTable maps them.
        const res = await this.collections.createRelationalTable(
          run.projectId,
          table.name,
          columns.map((c) => ({ name: c.name, type: mapType(c.type), nullable: c.nullable })),
          userId,
        );
        if (res.created) applied++;
      }
      // ALTER / DROP statements in a transaction.
      const { applied: stmtApplied } = await this.collections.runStatements(
        run.projectId,
        plan.statements ?? [],
        userId,
      );
      applied += stmtApplied;

      // Advance the generated snapshot to the current model.
      const blueprint = await this.blueprints.get(run.blueprintId, userId);
      await this.prisma.blueprint.update({
        where: { id: run.blueprintId },
        data: { generatedDataModel: blueprint.dataModel as Prisma.InputJsonValue },
      });

      return this.prisma.migrationRun.update({
        where: { id: run.id },
        data: { status: 'APPLIED', appliedCount: applied, appliedAt: new Date() },
      });
    } catch (e) {
      await this.prisma.migrationRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        },
      });
      throw e;
    }
  }
}

const PG_TYPE: Record<string, string> = {
  boolean: 'BOOLEAN',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  numeric: 'NUMERIC',
  uuid: 'UUID',
  date: 'DATE',
  timestamptz: 'TIMESTAMPTZ',
  jsonb: 'JSONB',
  text: 'TEXT',
};
function mapType(t: string): string {
  return PG_TYPE[t] ?? 'TEXT';
}
