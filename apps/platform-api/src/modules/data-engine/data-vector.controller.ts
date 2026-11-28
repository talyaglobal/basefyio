import {
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
import { DataEngineService, type EntityVectorConfig } from './data-engine.service';
import { toHttpError } from './data-engine.controller';
import { parseFilterParam } from './data-query-params';
import { SetVectorConfigDto, SetVectorDto, SetVectorsDto, VectorSearchDto } from './dto/vector.dto';

/** Default maximum cosine distance of a search, the same as the embeddings API. */
const DEFAULT_THRESHOLD = 0.5;

type VectorCollection = EntityCollection & Required<
  Pick<EntityCollection, 'setVector' | 'setVectors' | 'getVector' | 'deleteVector' | 'clearVectors' | 'vectorSearch' | 'vectorStats'>
>;

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
  constructor(private readonly dataEngine: DataEngineService) {}

  // ── Entity vector setup ──────────────────────────────

  @PlanGate('db_write')
  @Put('entities/:entity/vector-config')
  async setVectorConfig(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Body() body: SetVectorConfigDto,
  ): Promise<EntityVectorConfig> {
    const col = await this.vectorCollection(projectId, entity);
    const current = await this.dataEngine.getVectorConfig(projectId, entity);
    if (current && current.dimensions !== body.dimensions) {
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
    const config: EntityVectorConfig = {
      mode: 'client',
      dimensions: body.dimensions,
      updatedAt: new Date().toISOString(),
    };
    await this.dataEngine.setVectorConfig(projectId, entity, config);
    return config;
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
    const config = await this.dataEngine.getVectorConfig(projectId, entity);
    const caps = this.dataEngine.getEngine()?.capabilities().vector;
    try {
      const { embedded, total } = await col.vectorStats();
      return {
        mode: config?.mode ?? null,
        dimensions: config?.dimensions ?? null,
        embedded,
        total,
        maxScan: caps?.maxScan ?? null,
        strategy: caps?.strategy ?? null,
      };
    } catch (err) {
      throw toHttpError(err);
    }
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
    const col = await this.vectorCollection(projectId, entity);
    const config = await this.requireConfig(projectId, entity);
    const filter = parseFilterParam(body.filter);
    try {
      const result = await col.vectorSearch({
        vector: body.vector,
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
