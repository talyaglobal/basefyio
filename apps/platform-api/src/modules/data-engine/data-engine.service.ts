import { BadRequestException, ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Vector setup of an entity in client mode: the caller sends its own vectors. */
export interface ClientVectorConfig {
  mode: 'client';
  dimensions: number;
  updatedAt: string;
}

/** Platform mode: the platform computes each record's vector from its text. */
export interface PlatformVectorConfig {
  mode: 'platform';
  /** Width of the vectors, from the model at the time the mode was set. */
  dimensions: number;
  /** Dot paths under the record's data the text is built from, in this order. */
  sourcePaths: string[];
  /** Model tag ("provider/model") the stored vectors are made with. */
  modelTag: string;
  updatedAt: string;
}

/** Vector setup of an entity, kept on EntityDefinition.vectorConfig. */
export type EntityVectorConfig = ClientVectorConfig | PlatformVectorConfig;

export function parseVectorConfig(raw: unknown): EntityVectorConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.dimensions !== 'number') return null;
  if (c.mode === 'client') {
    return { mode: 'client', dimensions: c.dimensions, updatedAt: String(c.updatedAt ?? '') };
  }
  if (
    c.mode === 'platform' &&
    Array.isArray(c.sourcePaths) &&
    c.sourcePaths.every((p) => typeof p === 'string') &&
    typeof c.modelTag === 'string'
  ) {
    return {
      mode: 'platform',
      dimensions: c.dimensions,
      sourcePaths: c.sourcePaths as string[],
      modelTag: c.modelTag,
      updatedAt: String(c.updatedAt ?? ''),
    };
  }
  return null;
}

/** Progress of an entity's platform re-embed, kept on EntityDefinition.vectorReembedState. */
export interface VectorReembedState {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  done: number;
  total: number;
  failed: number;
  /** Model tag the run embeds with. */
  model: string;
  /** Width of that model's vectors. */
  dimensions: number | null;
  lastError: string | null;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
}

/** A QUEUED/RUNNING state older than this belongs to a worker that died. */
export const VECTOR_REEMBED_STALE_MS = 10 * 60 * 1000;

export function parseReembedState(raw: unknown): VectorReembedState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Partial<VectorReembedState>;
  if (typeof s.status !== 'string' || typeof s.updatedAt !== 'string') return null;
  return {
    status: s.status,
    done: Number(s.done ?? 0),
    total: Number(s.total ?? 0),
    failed: Number(s.failed ?? 0),
    model: String(s.model ?? ''),
    dimensions: typeof s.dimensions === 'number' ? s.dimensions : null,
    lastError: typeof s.lastError === 'string' ? s.lastError : null,
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    updatedAt: s.updatedAt,
    ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
  };
}

/** A run that is queued or running and not stale. */
export function reembedActive(state: VectorReembedState | null, now = Date.now()): boolean {
  return (
    !!state &&
    (state.status === 'QUEUED' || state.status === 'RUNNING') &&
    now - Date.parse(state.updatedAt) < VECTOR_REEMBED_STALE_MS
  );
}

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
        connectionString = `postgresql://${db.user || 'kolaybase'}:${db.password || ''}@${db.host || 'localhost'}:${db.port || '5432'}/${db.name || 'kolaybase'}`;
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
      vector: {
        maxScan: this.config.get<number>('dataEngine.vectorMaxScan') || 10_000,
        timeoutMs: this.config.get<number>('dataEngine.vectorTimeoutMs') || 5_000,
      },
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

  /** The entity's vector setup, or null when it stores no vectors. */
  async getVectorConfig(projectId: string, entityName: string): Promise<EntityVectorConfig | null> {
    const def = await this.prisma.entityDefinition.findUnique({
      where: { projectId_logicalName: { projectId, logicalName: entityName } },
      select: { vectorConfig: true },
    });
    return parseVectorConfig(def?.vectorConfig);
  }

  /** Store (or clear, with null) the entity's vector setup. */
  async setVectorConfig(
    projectId: string,
    entityName: string,
    config: EntityVectorConfig | null,
  ): Promise<void> {
    await this.prisma.entityDefinition.update({
      where: { projectId_logicalName: { projectId, logicalName: entityName } },
      data: { vectorConfig: config === null ? Prisma.DbNull : (config as unknown as Prisma.InputJsonValue) },
    });
  }

  /** The entity's vector setup and re-embed progress in one read. */
  async getVectorSetup(
    projectId: string,
    entityName: string,
  ): Promise<{ config: EntityVectorConfig | null; reembed: VectorReembedState | null }> {
    const def = await this.prisma.entityDefinition.findUnique({
      where: { projectId_logicalName: { projectId, logicalName: entityName } },
      select: { vectorConfig: true, vectorReembedState: true },
    });
    return { config: parseVectorConfig(def?.vectorConfig), reembed: parseReembedState(def?.vectorReembedState) };
  }

  /** Store (or clear, with null) the entity's platform re-embed progress. */
  async setVectorReembedState(
    projectId: string,
    entityName: string,
    state: VectorReembedState | null,
  ): Promise<void> {
    await this.prisma.entityDefinition.update({
      where: { projectId_logicalName: { projectId, logicalName: entityName } },
      data: {
        vectorReembedState: state === null ? Prisma.DbNull : (state as unknown as Prisma.InputJsonValue),
      },
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
    const { sanitizeEntityName, compileFieldsToJsonSchema } = await import('@basefyio/data-engine');
    const fields = data.fields ?? [];
    if (!Array.isArray(fields)) throw new BadRequestException('fields must be an array');
    const physicalName = sanitizeEntityName(data.logicalName);
    // Compiled before anything is written (#173): a malformed field list used to
    // fail after the entity row existed, answering 500 with the entity created.
    let snapshot: unknown;
    try {
      snapshot = compileFieldsToJsonSchema(fields as any);
    } catch (err: any) {
      throw new BadRequestException(`Invalid fields: ${err?.message ?? 'could not be compiled'}`);
    }

    let entity;
    try {
      entity = await this.prisma.$transaction(async (tx) => {
        const created = await tx.entityDefinition.create({
          data: {
            projectId,
            logicalName: data.logicalName,
            displayName: data.displayName,
            physicalCollection: physicalName,
            storageStrategy: 'shared-records',
            provider: this.config.get('dataEngine.provider') || 'postgres',
            fields: fields as any,
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
        await tx.entitySchemaVersion.create({
          data: { entityDefinitionId: created.id, version: 1, snapshot: snapshot as any, createdBy: 'system' },
        });
        await tx.dataEngineOutbox.create({
          data: { type: 'entity.created', projectId, entity: data.logicalName, schemaVersion: 1 },
        });
        return created;
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(`An entity named "${data.logicalName}" already exists in this project`);
      }
      throw err;
    }

    return entity;
  }
}
