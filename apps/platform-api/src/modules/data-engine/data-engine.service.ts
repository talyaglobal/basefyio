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

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private initAttempts = 0;
  private readonly MAX_RETRY_ATTEMPTS = 10;
  private readonly RETRY_INTERVAL_MS = 15_000;

  async onModuleInit() {
    await this.tryInit();
  }

  private async tryInitWithProvider(provider: string): Promise<boolean> {
    const { createDataEngine } = await import('@basefyio/data-engine');

    let connectionString: string;
    if (provider === 'postgres') {
      const dbUrl = process.env.DATABASE_URL;
      if (dbUrl) {
        connectionString = dbUrl;
      } else {
        const db = this.config.get<Record<string, string>>('database') || {};
        connectionString = `postgresql://${db.user || 'basefyio'}:${db.password || ''}@${db.host || 'localhost'}:${db.port || '5432'}/${db.name || 'basefyio'}`;
      }
    } else {
      connectionString = this.config.get<string>('dataEngine.connectionString') || '';
    }

    this.engine = await createDataEngine({
      provider: provider as 'nosql' | 'postgres' | 'couchdb' | 'mongodb',
      connectionString,
      username: this.config.get<string>('dataEngine.username') || '',
      password: this.config.get<string>('dataEngine.password') || '',
      container: this.config.get<string>('dataEngine.container') || 'basefyio-apps',
      namespace: this.config.get<string>('dataEngine.namespace') || 'projects',
      maxDocumentKb: this.config.get<number>('dataEngine.maxDocumentKb') || 1024,
      maxNestingDepth: this.config.get<number>('dataEngine.maxNestingDepth') || 8,
      maxArrayItems: this.config.get<number>('dataEngine.maxArrayItems') || 1000,
    });
    this.logger.log(`Data Engine initialized (provider: ${provider})`);
    return true;
  }

  private async tryInit() {
    const configuredProvider = this.config.get<string>('dataEngine.provider') || 'postgres';
    if (configuredProvider === 'disabled') {
      this.logger.log('Data Engine is disabled (DATA_ENGINE_PROVIDER=disabled)');
      return;
    }

    try {
      await this.tryInitWithProvider(configuredProvider);
      this.initAttempts = 0;
    } catch (err: any) {
      // If a document-store provider fails (missing SDK module, connection
      // refused, etc.), automatically fall back to the postgres provider.
      if (
        configuredProvider === 'nosql' ||
        configuredProvider === 'couchdb' ||
        configuredProvider === 'mongodb'
      ) {
        this.logger.warn(`Provider "${configuredProvider}" failed: ${err.message}. Falling back to postgres provider.`);
        try {
          await this.tryInitWithProvider('postgres');
          this.initAttempts = 0;
          return;
        } catch (fallbackErr: any) {
          this.logger.error(`Postgres fallback also failed: ${fallbackErr.message}`);
        }
      }

      this.initAttempts++;
      this.logger.error(`Data Engine init failed (attempt ${this.initAttempts}): ${err.message}`);
      if (this.initAttempts < this.MAX_RETRY_ATTEMPTS) {
        this.logger.log(`Retrying Data Engine init in ${this.RETRY_INTERVAL_MS / 1000}s...`);
        this.retryTimer = setTimeout(() => this.tryInit(), this.RETRY_INTERVAL_MS);
      } else {
        this.logger.warn(`Data Engine gave up after ${this.MAX_RETRY_ATTEMPTS} attempts. Use the health endpoint to check status.`);
      }
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

  private provisionedProjects = new Set<string>();

  /**
   * Ensure the data_engine schema and records table exist for a project.
   * Called lazily on first access — idempotent.
   */
  private async ensureProvisioned(projectId: string): Promise<void> {
    if (this.provisionedProjects.has(projectId)) return;
    if (!this.engine) return;
    try {
      await this.engine.provisionTenant(projectId);
      this.provisionedProjects.add(projectId);
    } catch (err: any) {
      this.logger.warn(`Auto-provision for ${projectId}: ${err.message}`);
    }
  }

  /**
   * Resolve an entity's physical collection and return an EntityCollection handle.
   */
  async getEntityCollection(projectId: string, entityName: string) {
    if (!this.engine) {
      throw new Error('Data Engine not available');
    }

    // Ensure schema/table exist (idempotent, cached after first success)
    await this.ensureProvisioned(projectId);

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
