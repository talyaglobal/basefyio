import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BlueprintService } from '../blueprint/blueprint.service';
import { ProjectDatabaseService } from '../projects/project-database.service';
import { DataModel } from '../blueprint/blueprint.types';
import {
  createTable,
  introspectTables,
  loadIntoExistingTable,
} from '../blueprint/blueprint-db';
import { sourceFor } from '../blueprint/blueprint-ddl';
import { MigrationPlan, planSchemaChanges } from './migration-diff';

/**
 * Schema migrations for a Blueprint's generated tables: compare the current
 * data model with the tables as they really are in the project database,
 * compile a plan, and apply it in one transaction (destructive changes
 * require an explicit force flag).
 * Re-implemented from the askin migrations concept, our patterns, no code copied.
 */
@Injectable()
export class MigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blueprints: BlueprintService,
    private readonly projectDb: ProjectDatabaseService,
  ) {}

  /** Build (and persist) a migration plan from the blueprint's pending changes. */
  async plan(blueprintId: string, userId?: string) {
    const blueprint = await this.blueprints.get(blueprintId, userId); // access check
    const projectId = blueprint.projectId;
    if (!projectId) {
      throw new BadRequestException('Blueprint has no target project; generate it first');
    }
    const target = blueprint.dataModel as unknown as DataModel;
    const snapshot = (blueprint.generatedDataModel as unknown as DataModel | null) ?? null;
    const names = [
      ...new Set([
        ...(target.tables ?? []).map((t) => t.name),
        ...(snapshot?.tables ?? []).map((t) => t.name),
      ]),
    ];
    let plan: MigrationPlan;
    try {
      const live = await this.projectDb.withProjectDb(projectId, userId, (client) =>
        introspectTables(client, names),
      );
      plan = planSchemaChanges({ target, live, snapshot });
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new BadRequestException(`Could not read the project's tables: ${messageOf(e)}`);
    }
    plan.targetModel = target;

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

  /**
   * Apply a pending plan in a single transaction: create new tables (keys,
   * access policies, and with `loadData` their rows), run the ALTER/DROP
   * statements, and with `loadData` fill tables this blueprint created that
   * are still empty. Any failure rolls the whole plan back.
   */
  async apply(runId: string, force: boolean, userId?: string, loadData = false) {
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

    const blueprint = await this.blueprints.get(run.blueprintId, userId);
    const snapshot = (blueprint.generatedDataModel as unknown as DataModel | null) ?? null;
    const access = snapshot?.access ?? 'service_role';
    const target = plan.targetModel ?? (blueprint.dataModel as unknown as DataModel);
    const sources = loadData ? await this.blueprints.getSourceSheets(run.blueprintId) : null;
    const owned = new Set((snapshot?.tables ?? []).map((t) => t.name));

    try {
      const applied = await this.projectDb.withProjectDb(run.projectId, userId, async (client) => {
        await client.query('BEGIN');
        try {
          let count = 0;
          const created = new Set<string>();
          for (const table of plan.newTables ?? []) {
            await createTable(client, table, access, sourceFor(table, sources));
            created.add(table.name);
            count++;
          }
          for (const sql of plan.statements ?? []) {
            await client.query(sql);
            count++;
          }
          if (sources) {
            const live = await introspectTables(client, [...owned]);
            for (const table of target.tables ?? []) {
              if (created.has(table.name) || !owned.has(table.name) || !live.has(table.name)) continue;
              const source = sourceFor(table, sources);
              if (source) await loadIntoExistingTable(client, table, source);
            }
          }
          await client.query('COMMIT');
          return count;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
      });

      // Advance the generated snapshot to the model this plan was built for.
      await this.prisma.blueprint.update({
        where: { id: run.blueprintId },
        data: {
          status: 'GENERATED',
          generatedDataModel: { ...target, access } as unknown as Prisma.InputJsonValue,
        },
      });

      return this.prisma.migrationRun.update({
        where: { id: run.id },
        data: { status: 'APPLIED', appliedCount: applied, appliedAt: new Date() },
      });
    } catch (e) {
      await this.prisma.migrationRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', error: messageOf(e) },
      });
      if (e instanceof NotFoundException) throw e;
      throw new BadRequestException(`Migration failed: ${messageOf(e)}`);
    }
  }
}

function messageOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}
