import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { VectorNotSupportedError, type EntityCollection } from '@basefyio/data-engine';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import { PlanGate } from '../../common/decorators/plan-gate.decorator';
import {
  DataEngineService,
  reembedActive,
  type ClientVectorConfig,
  type EntityVectorConfig,
  type PlatformVectorConfig,
} from './data-engine.service';
import { toHttpError } from './data-engine.controller';
import { parseFilterParam } from './data-query-params';
import { MAX_VECTOR_DIMENSIONS, SetVectorConfigDto, SetVectorDto, SetVectorsDto, VectorSearchDto } from './dto/vector.dto';
import { DataVectorEmbedderService } from './data-vector-embedder.service';
import { validateSourcePaths } from './vector-source';
import { ProjectEmbeddingService } from '../embedding/project-embedding.service';

/** Default maximum cosine distance of a search, the same as the embeddings API. */
const DEFAULT_THRESHOLD = 0.5;

type VectorCollection = EntityCollection & Required<
  Pick<EntityCollection, 'setVector' | 'setVectors' | 'getVector' | 'deleteVector' | 'clearVectors' | 'vectorSearch' | 'vectorStats'>
>;

/** 409 when the caller writes vectors the platform computes. */
function platformModeWrite(entity: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'VECTOR_MODE_PLATFORM',
    message:
      `Entity "${entity}" is in platform mode: its vectors are computed from the record's text. ` +
      'Switch it to client mode (PUT .../vector-config?purge=true with { "mode": "client", "dimensions": <n> }) to send your own.',
  });
}

/**
 * Vectors stored alongside a Data Engine record (one per record), and exact
 * nearest-neighbour search over an entity. Same access as the record routes:
 * service key or a dashboard session, never the anon key (the Data Engine has
 * no row-level policies). An entity stores vectors only after its
 * vector-config is set; until then nothing about it changes.
 */
@Controller('v1/projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class DataVectorController {
  constructor(
    private readonly dataEngine: DataEngineService,
    private readonly embedder: DataVectorEmbedderService,
    private readonly projectEmbedding: ProjectEmbeddingService,
  ) {}

  // ── Entity vector setup ──────────────────────────────

  @PlanGate('db_write')
  @Put('entities/:entity/vector-config')
  async setVectorConfig(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Body() body: SetVectorConfigDto,
    @Query('purge') purge?: string,
  ): Promise<EntityVectorConfig | (PlatformVectorConfig & { reembed: { queued: boolean; total: number } })> {
    if (body.mode === 'platform') return this.setPlatformConfig(projectId, entity, body, purge === 'true');
    if (body.sourcePaths !== undefined) {
      throw new BadRequestException('sourcePaths is only used in platform mode');
    }
    const col = await this.vectorCollection(projectId, entity);
    const current = await this.dataEngine.getVectorConfig(projectId, entity);
    if (purge === 'true') {
      await this.purge(col, projectId, entity);
    } else if (current?.mode === 'platform') {
      const stats = await col.vectorStats().catch((err) => {
        throw toHttpError(err);
      });
      if (stats.embedded > 0) {
        throw new ConflictException(
          `Entity "${entity}" holds ${stats.embedded} vectors the platform computed. ` +
            'Add ?purge=true to remove them and switch to client mode.',
        );
      }
    } else if (current && current.dimensions !== body.dimensions) {
      const stats = await col.vectorStats().catch((err) => {
        throw toHttpError(err);
      });
      if (stats.embedded > 0) {
        throw new ConflictException(
          `Entity "${entity}" holds ${stats.embedded} vectors of ${current.dimensions} dimensions. ` +
            'Remove them first with DELETE .../vector-config?purge=true, then set the new width.',
        );
      }
    }
    const config: ClientVectorConfig = {
      mode: 'client',
      dimensions: body.dimensions as number,
      updatedAt: new Date().toISOString(),
    };
    await this.dataEngine.setVectorConfig(projectId, entity, config);
    return config;
  }

  /**
   * Platform mode: the width and model tag come from the project's embedding
   * model (one cached probe). Existing records are embedded by a re-embed
   * job; changing the source paths re-embeds them too. Leaving client mode
   * while client vectors exist needs ?purge=true.
   */
  private async setPlatformConfig(
    projectId: string,
    entity: string,
    body: SetVectorConfigDto,
    purge: boolean,
  ): Promise<PlatformVectorConfig & { reembed: { queued: boolean; total: number } }> {
    if (body.dimensions !== undefined) {
      throw new BadRequestException(
        "dimensions is not set in platform mode: the width comes from the project's embedding model",
      );
    }
    const sourcePaths = validateSourcePaths(body.sourcePaths);
    const col = await this.vectorCollection(projectId, entity);
    // AI switched off → 403 AI_DISABLED; no key for the provider → 400.
    const project = await this.projectEmbedding.loadProject(projectId);
    const resolved = this.projectEmbedding.resolve(project);
    // Free plan on the platform key → 403 EMBEDDING_PLAN_REQUIRED now, not failing jobs later.
    await this.projectEmbedding.assertPlatformKeyAllowed(project, resolved);
    const { config: current, reembed } = await this.dataEngine.getVectorSetup(projectId, entity);

    let stats;
    try {
      stats = await col.vectorStats();
    } catch (err) {
      throw toHttpError(err);
    }

    if (current?.mode === 'platform' && !purge) {
      if (current.sourcePaths.join('\n') === sourcePaths.join('\n')) {
        return { ...current, reembed: { queued: false, total: stats.total } };
      }
      if (reembedActive(reembed)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'VECTOR_REEMBED_RUNNING',
          message: `A re-embed of "${entity}" is in progress (${reembed!.done}/${reembed!.total}). Change the source paths after it finishes.`,
        });
      }
      const next: PlatformVectorConfig = { ...current, sourcePaths, updatedAt: new Date().toISOString() };
      await this.dataEngine.setVectorConfig(projectId, entity, next);
      return { ...next, reembed: await this.backfill(projectId, entity, stats.total) };
    }

    if (purge) {
      await this.purge(col, projectId, entity);
    } else if (current?.mode === 'client' && stats.embedded > 0) {
      throw new ConflictException(
        `Entity "${entity}" holds ${stats.embedded} vectors sent by the client. ` +
          'Add ?purge=true to remove them and let the platform compute the vectors.',
      );
    }

    const dimensions = await this.projectEmbedding.dimensions(resolved);
    if (dimensions > MAX_VECTOR_DIMENSIONS) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'VECTOR_MODEL_TOO_WIDE',
        message: `${resolved.tag} produces ${dimensions}-dimensional vectors; the Data Engine stores at most ${MAX_VECTOR_DIMENSIONS}. Choose a narrower model for the project.`,
      });
    }
    const config: PlatformVectorConfig = {
      mode: 'platform',
      dimensions,
      sourcePaths,
      modelTag: resolved.tag,
      updatedAt: new Date().toISOString(),
    };
    await this.dataEngine.setVectorConfig(projectId, entity, config);
    return { ...config, reembed: await this.backfill(projectId, entity, stats.total) };
  }

  /** Queue the embedding of an entity's existing records; the config stands even if queueing fails. */
  private async backfill(projectId: string, entity: string, total: number): Promise<{ queued: boolean; total: number }> {
    if (total === 0) return { queued: false, total: 0 };
    try {
      const { queued, total: n } = await this.embedder.startReembed(projectId, entity);
      return { queued, total: n };
    } catch {
      // vector-status shows the records as pending; POST .../reembed retries.
      return { queued: false, total };
    }
  }

  /** Remove every vector of the entity and its re-embed progress. */
  private async purge(col: VectorCollection, projectId: string, entity: string): Promise<void> {
    try {
      await col.clearVectors();
    } catch (err) {
      throw toHttpError(err);
    }
    await this.dataEngine.setVectorReembedState(projectId, entity, null);
  }

  @Get('entities/:entity/vector-config')
  async getVectorConfig(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
  ): Promise<EntityVectorConfig> {
    await this.collection(projectId, entity);
    const config = await this.dataEngine.getVectorConfig(projectId, entity);
    if (!config) throw new NotFoundException(`Entity "${entity}" has no vector config`);
    return config;
  }

  @Delete('entities/:entity/vector-config')
  async deleteVectorConfig(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Query('purge') purge?: string,
  ): Promise<{ deleted: true; cleared: number }> {
    const col = await this.vectorCollection(projectId, entity);
    const config = await this.dataEngine.getVectorConfig(projectId, entity);
    if (!config) throw new NotFoundException(`Entity "${entity}" has no vector config`);
    try {
      const { embedded } = await col.vectorStats();
      if (embedded > 0 && purge !== 'true') {
        throw new ConflictException(
          `Entity "${entity}" holds ${embedded} vectors. Add ?purge=true to delete them with the config.`,
        );
      }
      // Also clears vectors left on soft-deleted records.
      const cleared = await col.clearVectors();
      await this.dataEngine.setVectorConfig(projectId, entity, null);
      if (config.mode === 'platform') await this.dataEngine.setVectorReembedState(projectId, entity, null);
      return { deleted: true, cleared };
    } catch (err) {
      throw toHttpError(err);
    }
  }

  @Get('entities/:entity/vector-status')
  async vectorStatus(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
  ) {
    const col = await this.vectorCollection(projectId, entity);
    const { config, reembed } = await this.dataEngine.getVectorSetup(projectId, entity);
    const caps = this.dataEngine.getEngine()?.capabilities().vector;
    const platform = config?.mode === 'platform' ? config : null;
    // The model the project embeds with now; a difference means search waits for a re-embed.
    const currentModelTag = platform ? await this.currentModelTag(projectId) : null;
    const usage = await this.platformKeyUsage(projectId);
    try {
      const stats = platform
        ? await col.vectorStats({ model: currentModelTag ?? platform.modelTag })
        : await col.vectorStats();
      return {
        mode: config?.mode ?? null,
        dimensions: config?.dimensions ?? null,
        embedded: stats.embedded,
        total: stats.total,
        maxScan: caps?.maxScan ?? null,
        strategy: caps?.strategy ?? null,
        modelTag: platform?.modelTag ?? null,
        sourcePaths: platform?.sourcePaths ?? null,
        currentModelTag,
        mismatch: !!platform && currentModelTag !== null && currentModelTag !== platform.modelTag,
        pending: platform ? (stats.pending ?? 0) : null,
        failed: platform ? (stats.failed ?? 0) : null,
        reembed: platform ? reembed : null,
        // Whether the project may compute embeddings on the platform's key (Pro and above, or its own key).
        platformKeyAllowed: usage?.platformKeyAllowed ?? null,
        dailyTokens:
          usage?.platformKey ? { limit: usage.limit, used: usage.used, resetsAt: usage.resetsAt } : null,
      };
    } catch (err) {
      throw toHttpError(err);
    }
  }

  /** Re-embed every record of a platform-mode entity with the project's current model. */
  @PlanGate('db_write')
  @Post('entities/:entity/reembed')
  @HttpCode(HttpStatus.ACCEPTED)
  async reembed(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
  ) {
    await this.vectorCollection(projectId, entity);
    const { queued, total, state } = await this.embedder.startReembed(projectId, entity);
    return { queued, total, reembed: state };
  }

  // ── Record vectors ───────────────────────────────────

  @PlanGate('db_write')
  @Put('data/:entity/:id/vector')
  async setVector(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body() body: SetVectorDto,
  ) {
    const col = await this.vectorCollection(projectId, entity);
    const config = await this.requireConfig(projectId, entity);
    if (config.mode === 'platform') throw platformModeWrite(entity);
    try {
      const info = await col.setVector(id, body.vector, { dimensions: config.dimensions });
      return { id: info.id, dims: info.dims, model: info.model, source: info.source, updatedAt: info.updatedAt };
    } catch (err) {
      throw toHttpError(err);
    }
  }

  @Get('data/:entity/:id/vector')
  async getVector(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
  ) {
    const col = await this.vectorCollection(projectId, entity);
    let info;
    try {
      info = await col.getVector(id);
    } catch (err) {
      throw toHttpError(err);
    }
    if (!info) throw new NotFoundException(`Document "${id}" has no vector`);
    return info;
  }

  @Delete('data/:entity/:id/vector')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteVector(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
  ): Promise<void> {
    const col = await this.vectorCollection(projectId, entity);
    try {
      await col.deleteVector(id);
    } catch (err) {
      throw toHttpError(err);
    }
  }

  @PlanGate('db_write')
  @Post('data/:entity/vectors')
  @HttpCode(HttpStatus.OK)
  async setVectors(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Body() body: SetVectorsDto,
  ) {
    const col = await this.vectorCollection(projectId, entity);
    const config = await this.requireConfig(projectId, entity);
    if (config.mode === 'platform') throw platformModeWrite(entity);
    try {
      return await col.setVectors(
        body.items.map((i) => ({ id: i.id, vector: i.vector })),
        { dimensions: config.dimensions },
      );
    } catch (err) {
      throw toHttpError(err);
    }
  }

  // ── Search ───────────────────────────────────────────

  @Post('data/:entity/search')
  @HttpCode(HttpStatus.OK)
  async search(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Body() body: VectorSearchDto,
  ) {
    if ((body.vector === undefined) === (body.query === undefined)) {
      throw new BadRequestException('Send exactly one of "vector" (numbers) or "query" (text)');
    }
    const col = await this.vectorCollection(projectId, entity);
    const config = await this.requireConfig(projectId, entity);
    const filter = parseFilterParam(body.filter);
    const vector = body.vector ?? (await this.embedQuery(projectId, entity, config, body.query as string));
    try {
      const result = await col.vectorSearch({
        vector,
        filter,
        limit: body.limit ?? 10,
        maxDistance: body.threshold ?? DEFAULT_THRESHOLD,
        dimensions: config.dimensions,
      });
      return {
        data: result.hits.map((h) => ({ ...h.doc, _distance: h.distance, _score: h.score })),
        scanned: result.scanned,
        strategy: result.strategy,
      };
    } catch (err) {
      throw toHttpError(err, 'query');
    }
  }

  // ── Helpers ──────────────────────────────────────────

  /**
   * The query text as a vector of the entity's model. Only platform-mode
   * entities: in client mode the stored vectors come from the caller's own
   * model, and a query embedded with the platform's would not be comparable.
   * Counts against the project's daily embedding budget.
   */
  private async embedQuery(
    projectId: string,
    entity: string,
    config: EntityVectorConfig,
    query: string,
  ): Promise<number[]> {
    if (config.mode !== 'platform') {
      throw new BadRequestException({
        statusCode: 400,
        code: 'VECTOR_QUERY_NEEDS_PLATFORM_MODE',
        message:
          `Entity "${entity}" stores vectors sent by the client, made with your own model. A text query would be ` +
          'embedded with the platform\'s model, and vectors of two models cannot be compared. Send "vector" ' +
          'computed with your model, or switch the entity to platform mode.',
      });
    }
    const project = await this.projectEmbedding.loadProject(projectId);
    const resolved = this.projectEmbedding.resolve(project);
    if (resolved.tag !== config.modelTag) throw this.modelMismatch(entity, config.modelTag, resolved.tag);
    const out = await this.projectEmbedding.embedForProject(project, [query], {
      intent: 'query',
      targetDimensions: config.dimensions,
      resolved,
    });
    // A provider failover answered with another model: its vector is not comparable either.
    if (out.tag !== config.modelTag) throw this.modelMismatch(entity, config.modelTag, out.tag);
    return out.vectors[0];
  }

  private modelMismatch(entity: string, stored: string, current: string): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: 'VECTOR_MODEL_MISMATCH',
      message:
        `The vectors of "${entity}" were made with ${stored}, but the project now embeds with ${current}. ` +
        `Re-embed the entity (POST .../entities/${entity}/reembed) and search again when it finishes.`,
    });
  }

  /** Plan and daily-limit facts for the status page, or null when the project cannot be read. */
  private async platformKeyUsage(projectId: string) {
    try {
      return await this.projectEmbedding.platformKeyUsage(await this.projectEmbedding.loadProject(projectId));
    } catch {
      return null;
    }
  }

  /** The project's current model tag, or null when the project cannot be read. */
  private async currentModelTag(projectId: string): Promise<string | null> {
    try {
      return this.projectEmbedding.describe(await this.projectEmbedding.loadProject(projectId)).tag;
    } catch {
      return null;
    }
  }

  private async requireConfig(projectId: string, entity: string): Promise<EntityVectorConfig> {
    const config = await this.dataEngine.getVectorConfig(projectId, entity);
    if (!config) {
      throw new ConflictException({
        statusCode: 409,
        code: 'VECTOR_CONFIG_MISSING',
        message:
          `Entity "${entity}" has no vector config. Set one first: ` +
          `PUT /api/v1/projects/${projectId}/entities/${entity}/vector-config with { "mode": "client", "dimensions": <n> }.`,
      });
    }
    return config;
  }

  /** The entity's collection, 501 VECTOR_NOT_SUPPORTED when the provider stores no vectors. */
  private async vectorCollection(projectId: string, entity: string): Promise<VectorCollection> {
    const col = await this.collection(projectId, entity);
    if (
      typeof col.setVector !== 'function' ||
      typeof col.setVectors !== 'function' ||
      typeof col.getVector !== 'function' ||
      typeof col.deleteVector !== 'function' ||
      typeof col.clearVectors !== 'function' ||
      typeof col.vectorSearch !== 'function' ||
      typeof col.vectorStats !== 'function'
    ) {
      throw toHttpError(new VectorNotSupportedError());
    }
    return col as VectorCollection;
  }

  /** Same mapping as the record routes: unknown entity 404, engine outage 503. */
  private async collection(projectId: string, entity: string): Promise<EntityCollection> {
    if (!this.dataEngine.isAvailable()) {
      throw new ServiceUnavailableException(
        'Data Engine is temporarily unavailable. The backing store may still be starting up — please try again in a moment.',
      );
    }
    try {
      return await this.dataEngine.getEntityCollection(projectId, entity);
    } catch (err: any) {
      const mapped = toHttpError(err);
      if (mapped instanceof HttpException) throw mapped;
      if (typeof err?.status === 'number') throw err;
      throw new ServiceUnavailableException('The data engine is unavailable right now. Try again shortly.');
    }
  }
}
