import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertDocumentBody,
  checkDocumentLimits,
  SchemaValidationError,
  stripEnvelopeFields,
  validateDocument,
} from '@basefyio/data-engine';
import type { EntityField, JsonObject } from '@basefyio/data-engine';
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
   * Resolve an entity's definition and its EntityCollection handle.
   * Throws EntityNotFoundError (404) for an unregistered entity.
   */
  async resolveEntity(projectId: string, entityName: string) {
    if (!this.engine) {
      throw new Error('Data Engine not available');
    }

    // Ensure schema/table exist (idempotent, cached after first success)
    await this.ensureProvisioned(projectId);

    const definition = await this.prisma.entityDefinition.findUnique({
      where: { projectId_logicalName: { projectId, logicalName: entityName } },
    });
    if (!definition) {
      const { EntityNotFoundError } = await import('@basefyio/data-engine');
      throw new EntityNotFoundError(entityName);
    }

    return { definition, collection: this.engine.collection(projectId, entityName) };
  }

  /**
   * Resolve an entity's physical collection and return an EntityCollection handle.
   */
  async getEntityCollection(projectId: string, entityName: string) {
    return (await this.resolveEntity(projectId, entityName)).collection;
  }

  /** The configured document limits. */
  documentLimits() {
    return {
      maxDocumentKb: this.config.get<number>('dataEngine.maxDocumentKb') || 1024,
      maxNestingDepth: this.config.get<number>('dataEngine.maxNestingDepth') || 8,
      maxArrayItems: this.config.get<number>('dataEngine.maxArrayItems') || 1000,
    };
  }

  /**
   * Check a write body before it reaches the store: it must be a JSON object,
   * envelope fields (_id, _version, …) are dropped, the size/depth/array limits
   * apply, and — unless DATA_ENGINE_SCHEMA_VALIDATION=off — the document must
   * satisfy the entity's field definitions. Returns the document to store.
   */
  async prepareWrite(
    definition: { fields: unknown },
    body: unknown,
    mode: 'create' | 'replace' | 'patch',
  ): Promise<JsonObject> {
    assertDocumentBody(body, mode === 'patch' ? 'Patch' : 'Document');
    const doc = stripEnvelopeFields(body);
    checkDocumentLimits(doc, this.documentLimits());

    if (this.config.get<string>('dataEngine.schemaValidation') !== 'off') {
      const fields = Array.isArray(definition.fields) ? definition.fields : [];
      const errors = validateDocument(doc, fields as EntityField[], mode);
      if (errors.length > 0) throw new SchemaValidationError(errors);
    }
    return doc;
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
   * List all entity definitions for a project. With `withCounts`, each entry
   * carries `documentCount` (active documents; null when the store cannot be
   * reached), which the dashboard shows next to every entity.
   */
  async listEntities(projectId: string, opts?: { withCounts?: boolean }) {
    const entities = await this.prisma.entityDefinition.findMany({
      where: { projectId },
      orderBy: { logicalName: 'asc' },
    });
    if (!opts?.withCounts) return entities;

    const engine = this.engine;
    if (!engine) return entities.map((e) => ({ ...e, documentCount: null as number | null }));
    await this.ensureProvisioned(projectId);
    return Promise.all(
      entities.map(async (e) => {
        let documentCount: number | null = null;
        try {
          documentCount = await engine.collection(projectId, e.logicalName).count();
        } catch (err: any) {
          this.logger.warn(`Count for ${projectId}/${e.logicalName} failed: ${err?.message}`);
        }
        return { ...e, documentCount };
      }),
    );
  }

  private async normalizeDefinitionInput(data: { fields?: unknown; rules?: unknown }) {
    const { normalizeEntityFields, compileFieldsToJsonSchema, EntityDefinitionError } =
      await import('@basefyio/data-engine');
    const fields = normalizeEntityFields(data.fields, {
      maxNestingDepth: this.documentLimits().maxNestingDepth,
    });
    if (data.rules !== undefined && data.rules !== null && !Array.isArray(data.rules)) {
      throw new EntityDefinitionError([{ path: 'rules', message: 'must be an array' }]);
    }
    const snapshot = compileFieldsToJsonSchema(fields, {
      maxNestingDepth: this.documentLimits().maxNestingDepth,
    });
    return { fields, snapshot };
  }

  /**
   * Register a new entity definition.
   *
   * The field list is validated before anything is written, and the
   * definition, its first schema version and the outbox event are created in
   * one transaction — a failure never leaves a half-created entity behind.
   */
  async createEntityDefinition(
    projectId: string,
    data: {
      logicalName: string;
      displayName: string;
      fields?: unknown;
      rules?: unknown[];
      description?: string;
      generatedByAI?: boolean;
      aiPrompt?: string;
      aiReasoning?: unknown;
      confidenceScore?: number;
      sourceWorkbook?: string;
      sourceSheet?: string;
    },
    createdBy?: string,
  ) {
    const { sanitizeEntityName, validateEntityName } = await import('@basefyio/data-engine');
    const logicalName = data.logicalName.trim();
    const nameCheck = validateEntityName(logicalName);
    if (!nameCheck.valid) {
      throw new BadRequestException({ message: nameCheck.error, code: 'INVALID_ENTITY_NAME' });
    }
    if (/[/\\?#%\u0000-\u001f]/.test(logicalName)) {
      throw new BadRequestException({
        message: 'Entity name must not contain /, \\, ?, #, % or control characters',
        code: 'INVALID_ENTITY_NAME',
      });
    }
    const physicalName = sanitizeEntityName(logicalName);
    const { fields, snapshot } = await this.normalizeDefinitionInput(data);

    const clash = await this.prisma.entityDefinition.findFirst({
      where: {
        projectId,
        OR: [{ logicalName }, { physicalCollection: physicalName }],
      },
      select: { logicalName: true },
    });
    if (clash) {
      throw new ConflictException({
        message:
          clash.logicalName === logicalName
            ? `An entity named "${logicalName}" already exists in this project`
            : `The name "${logicalName}" collides with the existing entity "${clash.logicalName}" (entity names are compared without case, spaces and punctuation)`,
        code: 'ENTITY_EXISTS',
      });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const entity = await tx.entityDefinition.create({
          data: {
            projectId,
            logicalName,
            displayName: data.displayName.trim(),
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
          data: {
            entityDefinitionId: entity.id,
            version: 1,
            snapshot: snapshot as any,
            createdBy: createdBy || 'system',
          },
        });

        await tx.dataEngineOutbox.create({
          data: {
            type: 'entity.created',
            projectId,
            entity: logicalName,
            schemaVersion: 1,
          },
        });

        return entity;
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException({
          message: `An entity named "${logicalName}" already exists in this project`,
          code: 'ENTITY_EXISTS',
        });
      }
      throw err;
    }
  }

  /**
   * Update an entity definition. Changing `fields` (or `rules`) publishes a
   * new schema version; documents already stored stay readable and are only
   * checked against the new definition when they are next written.
   */
  async updateEntityDefinition(
    projectId: string,
    entityName: string,
    data: { displayName?: string; description?: string | null; fields?: unknown; rules?: unknown },
    updatedBy?: string,
  ) {
    const current = await this.getEntityDefinition(projectId, entityName);
    if (!current) {
      throw new NotFoundException({ message: `Entity "${entityName}" not found`, code: 'ENTITY_NOT_FOUND' });
    }
    if (data.displayName !== undefined && (typeof data.displayName !== 'string' || !data.displayName.trim())) {
      throw new BadRequestException({ message: 'displayName must be a non-empty string', code: 'INVALID_ENTITY_DEFINITION' });
    }
    if (data.description !== undefined && data.description !== null && typeof data.description !== 'string') {
      throw new BadRequestException({ message: 'description must be a string', code: 'INVALID_ENTITY_DEFINITION' });
    }

    const schemaChanged = data.fields !== undefined || data.rules !== undefined;
    const normalized = schemaChanged
      ? await this.normalizeDefinitionInput({
          fields: data.fields !== undefined ? data.fields : current.fields,
          rules: data.rules,
        })
      : null;
    const nextVersion = schemaChanged ? current.schemaVersion + 1 : current.schemaVersion;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.entityDefinition.update({
        where: { id: current.id },
        data: {
          ...(data.displayName !== undefined ? { displayName: data.displayName.trim() } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(normalized ? { fields: normalized.fields as any, schemaVersion: nextVersion } : {}),
          ...(data.rules !== undefined ? { rules: (data.rules ?? []) as any } : {}),
        },
      });
      if (normalized) {
        await tx.entitySchemaVersion.create({
          data: {
            entityDefinitionId: current.id,
            version: nextVersion,
            snapshot: normalized.snapshot as any,
            createdBy: updatedBy || 'system',
          },
        });
        await tx.dataEngineOutbox.create({
          data: {
            type: 'entity.schema.changed',
            projectId,
            entity: current.logicalName,
            schemaVersion: nextVersion,
          },
        });
      }
      return updated;
    });
  }

  /**
   * Delete an entity definition. An entity that still holds documents
   * (soft-deleted ones included) is only deleted with `force`, which
   * permanently removes those documents first.
   */
  async deleteEntityDefinition(projectId: string, entityName: string, force: boolean) {
    const current = await this.getEntityDefinition(projectId, entityName);
    if (!current) {
      throw new NotFoundException({ message: `Entity "${entityName}" not found`, code: 'ENTITY_NOT_FOUND' });
    }

    if (!this.engine) {
      // Without the store the entity cannot be checked for (or emptied of) documents.
      throw new ServiceUnavailableException({
        message: 'Data Engine is temporarily unavailable, so the entity cannot be deleted right now. Please retry in a moment.',
        code: 'DATA_ENGINE_UNAVAILABLE',
      });
    }

    await this.ensureProvisioned(projectId);
    const collection = this.engine.collection(projectId, entityName);
    const stored = await collection.count(undefined, { includeSoftDeleted: true });
    if (stored > 0 && !force) {
      throw new ConflictException({
        message: `Entity "${entityName}" still holds ${stored} document(s), including deleted ones. Delete it with ?force=true to remove them permanently.`,
        code: 'ENTITY_NOT_EMPTY',
      });
    }
    let purged = 0;
    if (stored > 0) {
      if (!collection.purge) {
        throw new NotImplementedException({
          message: 'The configured Data Engine provider cannot remove documents in bulk; delete the documents first',
          code: 'NOT_SUPPORTED',
        });
      }
      purged = await collection.purge();
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.entityDefinition.delete({ where: { id: current.id } });
      await tx.dataEngineOutbox.create({
        data: {
          type: 'entity.deleted',
          projectId,
          entity: current.logicalName,
          schemaVersion: current.schemaVersion,
          payload: { documentsRemoved: purged } as any,
        },
      });
    });
    return { deleted: true, entity: current.logicalName, documentsRemoved: purged };
  }
}
