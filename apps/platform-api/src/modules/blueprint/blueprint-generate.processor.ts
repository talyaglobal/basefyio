import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { BLUEPRINT_GENERATE_QUEUE } from '../queue/queue.module';
import { generateDDL } from './lib/ddl-generator';

export interface BlueprintGenerateJobData {
  blueprintId: string;
  userId: string;
}

export interface BlueprintGenerateJobResult {
  projectId: string;
  tableCount: number;
  durationMs: number;
}

@Processor(BLUEPRINT_GENERATE_QUEUE, { concurrency: 2, lockDuration: 5 * 60_000 })
export class BlueprintGenerateProcessor extends WorkerHost {
  private readonly logger = new Logger(BlueprintGenerateProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(
    job: Job<BlueprintGenerateJobData, BlueprintGenerateJobResult>,
  ): Promise<BlueprintGenerateJobResult> {
    const started = Date.now();
    const { blueprintId, userId } = job.data;

    this.logger.log(`Generate job ${job.id} starting: blueprint=${blueprintId}`);

    // 1. Load blueprint + current version
    const blueprint = await (this.prisma as any).blueprint.findUnique({
      where: { id: blueprintId },
    });
    if (!blueprint) throw new Error(`Blueprint ${blueprintId} not found`);
    if (!['approved', 'draft'].includes(blueprint.status)) {
      throw new Error(`Blueprint ${blueprintId} is in status ${blueprint.status}, cannot generate`);
    }

    // Mark as generating
    await (this.prisma as any).blueprint.update({
      where: { id: blueprintId },
      data: { status: 'generating' },
    });

    await job.updateProgress({ step: 'ddl', percent: 10 });

    // 2. Load current application version
    const currentVersion = blueprint.currentVersionId
      ? await (this.prisma as any).applicationVersion.findUnique({
          where: { id: blueprint.currentVersionId },
        })
      : null;

    const dataModel = blueprint.dataModel as { tables: Array<{ name: string; displayName: string; fields: any[] }> };
    const tables = dataModel.tables ?? [];

    // 3. Generate DDL
    const ddlStatements = generateDDL(tables);
    this.logger.log(`Generated ${ddlStatements.length} DDL statements for blueprint ${blueprintId}`);

    await job.updateProgress({ step: 'entities', percent: 40, tableCount: tables.length });

    // 4. Determine or create projectId
    let projectId = blueprint.projectId as string | null;
    if (!projectId) {
      // Create a minimal project placeholder. Full ProjectsService.create() involves
      // Keycloak + DB provisioning; here we create a lightweight record that will be
      // updated when real provisioning runs.
      const shortId = blueprintId.replace(/-/g, '').slice(0, 8);
      const project = await (this.prisma as any).project.create({
        data: {
          name: `Blueprint App ${shortId}`,
          slug: `bp-${shortId}`,
          teamId: blueprint.teamId,
          createdBy: userId,
          status: 'ACTIVE',
          dbHost: 'localhost',
          dbPort: 5432,
          dbName: `bf_bp_${blueprintId.replace(/-/g, '').slice(0, 16)}`,
          dbUser: `bf_${blueprintId.replace(/-/g, '').slice(0, 10)}`,
          dbPassword: '',
          keycloakRealm: `bf-bp-${shortId}`,
          anonKey: '',
          serviceKey: '',
          modules: {},
        },
      });
      projectId = project.id;
      await (this.prisma as any).blueprint.update({
        where: { id: blueprintId },
        data: { projectId },
      });
    }

    // 5. Seed AppEntity rows (upsert to handle re-generation)
    for (const table of tables) {
      await (this.prisma as any).appEntity.upsert({
        where: { projectId_tableName: { projectId: projectId!, tableName: table.name } },
        update: {
          entityName: table.displayName,
          description: `Auto-generated from Blueprint ${blueprintId}`,
          metadata: { ddl: ddlStatements.find(s => s.includes(`"${table.name}"`)) ?? '' },
        },
        create: {
          projectId: projectId!,
          entityName: table.displayName,
          tableName: table.name,
          description: `Auto-generated from Blueprint ${blueprintId}`,
          metadata: {
            ddl: ddlStatements.find(s => s.includes(`"${table.name}"`)) ?? '',
            sourceBlueprint: blueprintId,
          },
        },
      });
    }

    await job.updateProgress({ step: 'build_package', percent: 70 });

    // 6. Build the BuildPackage (inter-product Nfyio handoff)
    const applicationModel = currentVersion?.applicationModel ?? {
      name: `Blueprint App`,
      roles: [{ name: 'admin', permissions: {} }],
      navigation: tables.map((t: any) => ({ label: t.displayName, table: t.name, icon: 'table' })),
    };

    const buildPackage = {
      version: 1,
      blueprintId,
      projectId,
      generatedAt: new Date().toISOString(),
      dataModel,
      applicationModel,
      uiModel: blueprint.uiModel,
      ddl: ddlStatements,
    };

    // 7. Mark blueprint as generated
    await (this.prisma as any).blueprint.update({
      where: { id: blueprintId },
      data: {
        status: 'generated',
        projectId,
        // Store the build package in the uiModel JSON alongside pages (V1 embedding)
        uiModel: {
          ...(blueprint.uiModel as object),
          buildPackage,
        },
      },
    });

    await job.updateProgress({ step: 'done', percent: 100 });

    const durationMs = Date.now() - started;
    this.logger.log(`Generate job ${job.id} done: blueprint=${blueprintId} tables=${tables.length} ${durationMs}ms`);

    return { projectId: projectId!, tableCount: tables.length, durationMs };
  }
}
