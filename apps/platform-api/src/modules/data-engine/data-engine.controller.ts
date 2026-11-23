import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  HttpCode,
  HttpStatus,
  HttpException,
  Headers,
  Res,
  NotImplementedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { parseFilterParam, parseSortParam } from './data-query-params';
import { validateDocument } from './document-validation';
import { DataEngineService } from './data-engine.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { AnonKeyAllowed, ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PlanGate } from '../../common/decorators/plan-gate.decorator';

/**
 * The data engine.
  *
  * Entity creation is DDL, and every data route can trigger provisioning as a
  * side effect. The engine client runs as owner with no role switch, so none of
  * it is policy-governed.
 */
/**
 * Engine errors carry their own status (404 not found, 409 version conflict,
 * 422 validation, 413 too large, 400 bad query): answer with it and the
 * engine's message instead of a 500 (#173). A driver error inside a query is a
 * bad filter, answered 400 without the driver's internals.
 */
export function toHttpError(err: any, context: 'query' | 'write' = 'write'): unknown {
  if (err instanceof HttpException) return err;
  const status = typeof err?.statusCode === 'number' ? err.statusCode : undefined;
  if (status && status >= 400 && status < 600 && typeof err?.code === 'string') {
    return new HttpException({ statusCode: status, code: err.code, message: err.message }, status);
  }
  if (context === 'query') {
    return new BadRequestException('The filter could not be run. Check its operators and values.');
  }
  return err;
}

/** `If-Match: 3`, `"3"` or `W/"3"` as a version number; undefined when absent, 400 when malformed. */
export function parseIfMatch(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '' || raw === '*') return undefined;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim());
  if (!m) throw new BadRequestException('If-Match must be a document version, e.g. If-Match: "3"');
  return Number(m[1]);
}

function setEtag(res: Response, doc: unknown): void {
  const v = (doc as { _version?: unknown } | null)?._version;
  if (typeof v === 'number') res.setHeader('ETag', `"${v}"`);
}

@Controller('v1/projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class DataEngineController {
  constructor(private readonly dataEngine: DataEngineService) {}

  // ── Entity Management ────────────────────────────────

  @Get('entities')
  async listEntities(
    @Param('projectId') projectId: string,
    @Query('withCounts') withCounts?: string,
  ) {
    const defs = await this.dataEngine.listEntities(projectId);
    if (withCounts !== 'true' || !this.dataEngine.isAvailable()) return defs;
    // Document counts for the Data sidebar (#176). Each is bounded; a count that
    // fails or is slow is null and never fails the list.
    return Promise.all(
      defs.map(async (d) => ({ ...d, documentCount: await this.countOrNull(projectId, d.logicalName) })),
    );
  }

  private async countOrNull(projectId: string, entity: string): Promise<number | null> {
    try {
      const col = await this.dataEngine.getEntityCollection(projectId, entity);
      return await Promise.race([
        col.count(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000).unref?.()),
      ]);
    } catch {
      return null;
    }
  }

  @PlanGate('db_write')
  @Post('entities')
  async createEntity(
    @Param('projectId') projectId: string,
    @Body() body: {
      logicalName: string;
      displayName: string;
      fields: unknown[];
      rules?: unknown[];
      description?: string;
      generatedByAI?: boolean;
      aiPrompt?: string;
    },
    @CurrentUser() user?: JwtPayload,
  ) {
    if (!body.logicalName?.trim()) {
      throw new BadRequestException('logicalName is required');
    }
    if (!body.displayName?.trim()) {
      throw new BadRequestException('displayName is required');
    }
    return this.dataEngine.createEntityDefinition(projectId, body);
  }

  @Get('entities/:entity')
  async getEntity(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
  ) {
    const def = await this.dataEngine.getEntityDefinition(projectId, entity);
    if (!def) throw new NotFoundException(`Entity "${entity}" not found`);
    return def;
  }

  // ── Document CRUD ────────────────────────────────────

  @PlanGate('db_write')
  @Post('data/:entity')
  async createRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.assertEngineAvailable();
    const col = await this.collection(projectId, entity);
    validateDocument(body, (await this.dataEngine.getEntityDefinition(projectId, entity))?.fields);
    try {
      return await col.insert(body as any, { userId: user?.sub });
    } catch (err) {
      throw toHttpError(err);
    }
  }

  @Get('data/:entity')
  async listRecords(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Query('filter') filterRaw?: string,
    @Query('sort') sortRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
    @Query('includeSoftDeleted') includeSoftDeletedRaw?: string,
  ) {
    this.assertEngineAvailable();

    const col = await this.collection(projectId, entity);

    const filter = parseFilterParam(filterRaw);
    const sort = parseSortParam(sortRaw);
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : undefined;

    try {
      return await col.query({
        entity,
        filter,
        sort,
        limit,
        offset,
        // Soft-deleted documents are listed only when asked for (they can be restored).
        includeSoftDeleted: includeSoftDeletedRaw === 'true',
      });
    } catch (err: any) {
      throw toHttpError(err, 'query');
    }
  }

  @Get('data/:entity/:id')
  async getRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertEngineAvailable();
    const col = await this.collection(projectId, entity);
    const doc = await col.get(id).catch((err) => {
      throw toHttpError(err);
    });
    if (!doc) throw new NotFoundException(`Document "${id}" not found`);
    setEtag(res, doc);
    return doc;
  }

  @PlanGate('db_write')
  @Patch('data/:entity/:id')
  async updateRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatchRaw?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.assertEngineAvailable();
    const ifMatch = parseIfMatch(ifMatchRaw);
    const col = await this.collection(projectId, entity);
    validateDocument(body, (await this.dataEngine.getEntityDefinition(projectId, entity))?.fields, { partial: true });
    try {
      const doc = await col.update(id, body as any, { userId: user?.sub, ifMatch });
      setEtag(res, doc);
      return doc;
    } catch (err) {
      throw toHttpError(err);
    }
  }

  @PlanGate('db_write')
  @Put('data/:entity/:id')
  async replaceRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatchRaw?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.assertEngineAvailable();
    const ifMatch = parseIfMatch(ifMatchRaw);
    const col = await this.collection(projectId, entity);
    validateDocument(body, (await this.dataEngine.getEntityDefinition(projectId, entity))?.fields);
    try {
      const doc = await col.replace(id, body as any, { userId: user?.sub, ifMatch });
      setEtag(res, doc);
      return doc;
    } catch (err) {
      throw toHttpError(err);
    }
  }

  @Delete('data/:entity/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.assertEngineAvailable();
    const col = await this.collection(projectId, entity);
    try {
      await col.delete(id, { userId: user?.sub });
    } catch (err) {
      throw toHttpError(err);
    }
  }

  /** Bring a soft-deleted document back (#173). 404 when no deleted document has this id. */
  @PlanGate('db_write')
  @Post('data/:entity/:id/restore')
  async restoreRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.assertEngineAvailable();
    const col = await this.collection(projectId, entity);
    if (typeof col.restore !== 'function') {
      throw new NotImplementedException('This data engine provider cannot restore deleted documents');
    }
    try {
      const doc = await col.restore(id, { userId: user?.sub });
      setEtag(res, doc);
      return doc;
    } catch (err) {
      throw toHttpError(err);
    }
  }

  // ── Health ───────────────────────────────────────────

  @Get('data-engine/health')
  @AnonKeyAllowed() // liveness only
  async health(@Param('projectId') projectId: string) {
    const available = this.dataEngine.isAvailable();
    const reachable = available ? await this.dataEngine.ping() : false;
    return { available, reachable };
  }

  // ── Helpers ──────────────────────────────────────────

  /**
   * The entity's collection. An unknown entity is the engine's 404 and stays
   * one; only a real engine outage is a 503, without its internal message.
   */
  private async collection(projectId: string, entity: string) {
    try {
      return await this.dataEngine.getEntityCollection(projectId, entity);
    } catch (err: any) {
      const mapped = toHttpError(err);
      if (mapped instanceof HttpException) throw mapped;
      if (typeof err?.status === 'number') throw err;
      throw new ServiceUnavailableException('The data engine is unavailable right now. Try again shortly.');
    }
  }

  private assertEngineAvailable(): void {
    if (!this.dataEngine.isAvailable()) {
      throw new ServiceUnavailableException(
        'Data Engine is temporarily unavailable. The backing store may still be starting up — please try again in a moment.',
      );
    }
  }
}
