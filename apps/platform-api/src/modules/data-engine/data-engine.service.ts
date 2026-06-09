import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Data Engine service — the NestJS-injectable wrapper around the
 * @basefyio/data-engine package. Configured from env vars.
 *
 * This service does NOT import any vendor SDK directly.
 * All document access goes through the DataEngine abstraction.
 */
@Injectable()
export class DataEngineService implements OnModuleInit {
  private readonly logger = new Logger(DataEngineService.name);
  private engine: import('@basefyio/data-engine').DataEngine | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const provider = this.config.get<string>('dataEngine.provider') || 'postgres';
    if (provider === 'disabled') {
      this.logger.log('Data Engine is disabled (DATA_ENGINE_PROVIDER=disabled)');
      return;
    }

    try {
      const { createDataEngine } = await import('@basefyio/data-engine');
      this.engine = await createDataEngine({
        provider: provider as 'nosql' | 'postgres',
        connectionString: this.config.get<string>('dataEngine.connectionString') || this.config.get<string>('database.url') || '',
        username: this.config.get<string>('dataEngine.username') || '',
        password: this.config.get<string>('dataEngine.password') || '',
        container: this.config.get<string>('dataEngine.container') || 'basefyio-apps',
        namespace: this.config.get<string>('dataEngine.namespace') || 'projects',
        maxDocumentKb: this.config.get<number>('dataEngine.maxDocumentKb') || 1024,
        maxNestingDepth: this.config.get<number>('dataEngine.maxNestingDepth') || 8,
        maxArrayItems: this.config.get<number>('dataEngine.maxArrayItems') || 1000,
      });
      this.logger.log(`Data Engine initialized (provider: ${provider})`);
    } catch (err: any) {
      this.logger.error(`Data Engine init failed: ${err.message}`);
      // Non-fatal — data plane is optional, control plane continues
    }
  }

  /** Returns the engine instance or null if disabled/failed. */
  getEngine(): import('@basefyio/data-engine').DataEngine | null {
    return this.engine;
  }

  /** Returns true if the data engine is available. */
  isAvailable(): boolean {
    return this.engine !== null;
  }

  /** Health check — returns true if backing store is reachable. */
  async ping(): Promise<boolean> {
    if (!this.engine) return false;
    try {
      return await this.engine.ping();
    } catch {
      return false;
    }
  }

  /**
   * Provision data plane for a project.
   * Called by the provisioning queue processor.
   */
  async provisionTenant(projectId: string, tier?: 'shared' | 'dedicated-scope'): Promise<void> {
    if (!this.engine) {
      throw new Error('Data Engine not available');
    }

    await this.prisma.dataPlaneProvisioning.upsert({
      where: { projectId },
      create: { projectId, status: 'PROVISIONING', provider: this.config.get('dataEngine.provider') || 'postgres', tier: tier || 'shared' },
      update: { status: 'PROVISIONING', updatedAt: new Date() },
    });

    try {
      const result = await this.engine.provisionTenant(projectId, tier);
      await this.prisma.dataPlaneProvisioning.update({
        where: { projectId },
        data: {
          status: 'READY',
          namespace: result.namespace,
          provisionedAt: new Date(result.provisionedAt),
        },
      });
      this.logger.log(`Data plane provisioned for project ${projectId}`);
    } catch (err: any) {
      await this.prisma.dataPlaneProvisioning.update({
        where: { projectId },
        data: {
          status: 'FAILED',
          lastError: err.message?.slice(0, 2000),
          retryCount: { increment: 1 },
        },
      });
      throw err;
    }
  }

  /**
   * Deprovision data plane for a project.
   */
  async deprovisionTenant(projectId: string): Promise<void> {
    if (!this.engine) return;

    await this.prisma.dataPlaneProvisioning.updateMany({
      where: { projectId, status: { not: 'DELETED' } },
      data: { status: 'DELETING' },
    });

    try {
      await this.engine.deprovisionTenant(projectId);
      await this.prisma.dataPlaneProvisioning.updateMany({
        where: { projectId },
        data: { status: 'DELETED' },
      });
      this.logger.log(`Data plane deprovisioned for project ${projectId}`);
    } catch (err: any) {
      this.logger.error(`Deprovision failed for ${projectId}: ${err.message}`);
      await this.prisma.dataPlaneProvisioning.updateMany({
        where: { projectId },
        data: { status: 'FAILED', lastError: err.message?.slice(0, 2000) },
      });
    }
  }

  /**
   * Resolve an entity's physical collection and return an EntityCollection handle.
   */
  async getEntityCollection(projectId: string, entityName: string) {
    if (!this.engine) {
      throw new Error('Data Engine not available');
    }

    // Verify entity exists in metadata
    const entity = await this.prisma.entityDefinition.findUnique({
      where: { projectId_logicalName: { projectId, logicalName: entityName } },
    });
    if (!entity) {
      const { EntityNotFoundError } = await import('@basefyio/data-engine');
      throw new EntityNotFoundError(entityName);
    }

    return this.engine.collection(projectId, entityName);
  }

  /**
   * Get entity definition metadata.
   */
  async getEntityDefinition(projectId: string, entityName: string) {
    return this.prisma.entityDefinition.findUnique({
      where: { projectId_logicalName: { projectId, logicalName: entityName } },
    });
  }

  /**
   * List all entity definitions for a project.
   */
  async listEntities(projectId: string) {
    return this.prisma.entityDefinition.findMany({
      where: { projectId },
      orderBy: { logicalName: 'asc' },
    });
  }

  /**
   * Register a new entity definition.
   */
  async createEntityDefinition(
    projectId: string,
    data: {
      logicalName: string;
      displayName: string;
      fields: unknown[];
      rules?: unknown[];
      description?: string;
      generatedByAI?: boolean;
      aiPrompt?: string;
      aiReasoning?: unknown;
      confidenceScore?: number;
      sourceWorkbook?: string;
      sourceSheet?: string;
    },
  ) {
    const { sanitizeEntityName } = await import('@basefyio/data-engine');
    const physicalName = sanitizeEntityName(data.logicalName);

    const entity = await this.prisma.entityDefinition.create({
      data: {
        projectId,
        logicalName: data.logicalName,
        displayName: data.displayName,
        physicalCollection: physicalName,
        storageStrategy: 'shared-records',
        provider: this.config.get('dataEngine.provider') || 'postgres',
        fields: data.fields as any,
        rules: (data.rules ?? []) as any,
        description: data.description,
        generatedByAI: data.generatedByAI ?? false,
        aiPrompt: data.aiPrompt,
        aiReasoning: data.aiReasoning as any,
        confidenceScore: data.confidenceScore,
        sourceWorkbook: data.sourceWorkbook,
        sourceSheet: data.sourceSheet,
      },
    });

    // Create initial schema version
    const { compileFieldsToJsonSchema } = await import('@basefyio/data-engine');
    const snapshot = compileFieldsToJsonSchema(data.fields as any);

    await this.prisma.entitySchemaVersion.create({
      data: {
        entityDefinitionId: entity.id,
        version: 1,
        snapshot: snapshot as any,
        createdBy: 'system',
      },
    });

    // Write outbox event
    await this.prisma.dataEngineOutbox.create({
      data: {
        type: 'entity.created',
        projectId,
        entity: data.logicalName,
        schemaVersion: 1,
      },
    });

    return entity;
  }
}
