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
  Headers,
  Res,
  UseGuards,
  NotFoundException,
  BadRequestException,
  NotImplementedException,
  ServiceUnavailableException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DataEngineService } from './data-engine.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { AnonKeyAllowed, ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import {
  entityNotRegisteredMessage,
  etagFor,
  isExpectedError,
  ListQueryParams,
  parseBooleanFlag,
  parseFilterQuery,
  parseIfMatch,
  parseListQuery,
  projectDocument,
  toDataEngineHttpError,
} from './data-engine-http.util';

/** Most documents one POST may insert. */
const MAX_BULK_INSERT = 1000;

/**
 * The data engine.
  *
  * Entity creation is DDL, and every data route can trigger provisioning as a
  * side effect. The engine client runs as owner with no role switch, so none of
  * it is policy-governed.
 */
@Controller('v1/projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class DataEngineController {
  private readonly logger = new Logger(DataEngineController.name);

  constructor(private readonly dataEngine: DataEngineService) {}

  // ── Entity Management ────────────────────────────────

  @Get('entities')
  async listEntities(
    @Param('projectId') projectId: string,
    @Query('withCounts') withCounts?: string,
  ) {
    return this.dataEngine.listEntities(projectId, { withCounts: parseBooleanFlag(withCounts) });
  }

  @Post('entities')
  async createEntity(
    @Param('projectId') projectId: string,
    @Body() body: {
      logicalName: string;
      displayName: string;
      fields?: unknown[];
      rules?: unknown[];
      description?: string;
      generatedByAI?: boolean;
      aiPrompt?: string;
    },
    @CurrentUser() user?: JwtPayload,
  ) {
    if (typeof body?.logicalName !== 'string' || !body.logicalName.trim()) {
      throw new BadRequestException('logicalName is required');
    }
    if (typeof body.displayName !== 'string' || !body.displayName.trim()) {
      throw new BadRequestException('displayName is required');
    }
    return this.run(() => this.dataEngine.createEntityDefinition(projectId, body, user?.sub));
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

  @Patch('entities/:entity')
  async updateEntity(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Body() body: { displayName?: string; description?: string | null; fields?: unknown[]; rules?: unknown[] },
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.run(() => this.dataEngine.updateEntityDefinition(projectId, entity, body ?? {}, user?.sub));
  }

  @Delete('entities/:entity')
  async deleteEntity(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Query('force') force?: string,
  ) {
    return this.run(() => this.dataEngine.deleteEntityDefinition(projectId, entity, parseBooleanFlag(force)));
  }

  // ── Document CRUD ────────────────────────────────────

  /** One object inserts one document; an array (max 1000) inserts each one. */
  @Post('data/:entity')
  async createRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.run(async () => {
      const { definition, collection } = await this.resolve(projectId, entity);

      if (Array.isArray(body)) {
        if (body.length === 0) throw new BadRequestException('No documents provided');
        if (body.length > MAX_BULK_INSERT) {
          throw new BadRequestException(`At most ${MAX_BULK_INSERT} documents can be inserted per request`);
        }
        const docs = [];
        for (let i = 0; i < body.length; i++) {
          try {
            docs.push(await this.dataEngine.prepareWrite(definition, body[i], 'create'));
          } catch (err: any) {
            // Name the failing element; nothing has been written yet.
            if (typeof err?.message === 'string') err.message = `Document [${i}]: ${err.message}`;
            throw err;
          }
        }
        if (collection.insertMany) {
          return collection.insertMany(docs, { userId: user?.sub });
        }
        const created = [];
        for (const doc of docs) created.push(await collection.insert(doc, { userId: user?.sub }));
        return created;
      }

      const doc = await this.dataEngine.prepareWrite(definition, body, 'create');
      const created = await collection.insert(doc, { userId: user?.sub });
      this.setEtag(res, created);
      return created;
    });
  }

  @Get('data/:entity')
  async listRecords(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Query() query: ListQueryParams,
  ) {
    return this.run(async () => {
      const q = parseListQuery(entity, query);
      const { collection } = await this.resolve(projectId, entity);
      const page = await collection.query(q);
      if (q.select?.length) {
        page.data = page.data.map((doc) => projectDocument(doc, q.select));
      }
      return page;
    });
  }

  @Get('data/:entity/count')
  async countRecords(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Query('filter') filterRaw?: string,
    @Query('includeSoftDeleted') includeSoftDeleted?: string,
  ) {
    return this.run(async () => {
      const filter = parseFilterQuery(filterRaw);
      const { collection } = await this.resolve(projectId, entity);
      const count = await collection.count(filter, {
        includeSoftDeleted: parseBooleanFlag(includeSoftDeleted),
      });
      return { count };
    });
  }

  @Get('data/:entity/:id')
  async getRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Query('includeSoftDeleted') includeSoftDeleted: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(async () => {
      const { collection } = await this.resolve(projectId, entity);
      const doc = await collection.get(id, { includeSoftDeleted: parseBooleanFlag(includeSoftDeleted) });
      if (!doc) throw new NotFoundException(`Document "${id}" not found`);
      this.setEtag(res, doc);
      return doc;
    });
  }

  @Patch('data/:entity/:id')
  async updateRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.run(async () => {
      const ifMatch = parseIfMatch(ifMatchHeader);
      const { definition, collection } = await this.resolve(projectId, entity);
      const patch = await this.dataEngine.prepareWrite(definition, body, 'patch');
      const updated = await collection.update(id, patch, { userId: user?.sub, ifMatch });
      this.setEtag(res, updated);
      return updated;
    });
  }

  @Put('data/:entity/:id')
  async replaceRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.run(async () => {
      const ifMatch = parseIfMatch(ifMatchHeader);
      const { definition, collection } = await this.resolve(projectId, entity);
      const doc = await this.dataEngine.prepareWrite(definition, body, 'replace');
      const replaced = await collection.replace(id, doc, { userId: user?.sub, ifMatch });
      this.setEtag(res, replaced);
      return replaced;
    });
  }

  @Delete('data/:entity/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.run(async () => {
      const ifMatch = parseIfMatch(ifMatchHeader);
      const { collection } = await this.resolve(projectId, entity);
      await collection.delete(id, { userId: user?.sub, ifMatch });
    });
  }

  /** Undo a soft delete. */
  @Post('data/:entity/:id/restore')
  async restoreRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.run(async () => {
      const ifMatch = parseIfMatch(ifMatchHeader);
      const { collection } = await this.resolve(projectId, entity);
      if (!collection.restore) {
        throw new NotImplementedException('The configured Data Engine provider cannot restore deleted documents');
      }
      const restored = await collection.restore(id, { userId: user?.sub, ifMatch });
      this.setEtag(res, restored);
      return restored;
    });
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

  private assertEngineAvailable(): void {
    if (!this.dataEngine.isAvailable()) {
      throw new ServiceUnavailableException(
        'Data Engine is temporarily unavailable. The backing store may still be starting up — please try again in a moment.',
      );
    }
  }

  private async resolve(projectId: string, entity: string) {
    this.assertEngineAvailable();
    try {
      return await this.dataEngine.resolveEntity(projectId, entity);
    } catch (err: any) {
      if (err?.code === 'ENTITY_NOT_FOUND') {
        throw new NotFoundException({ message: entityNotRegisteredMessage(entity), code: 'ENTITY_NOT_FOUND' });
      }
      throw err;
    }
  }

  private setEtag(res: Response, doc: { _version?: unknown }): void {
    const etag = etagFor(doc);
    if (etag) res.setHeader('ETag', etag);
  }

  /**
   * Run a handler and translate engine errors to HTTP statuses: validation
   * 400/422, missing 404, version conflict 409, too large 413. Unexpected
   * errors are logged and answered with a generic 500 that leaks no internals.
   */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (!isExpectedError(err)) {
        this.logger.error(`Data Engine request failed: ${err?.message}`, err?.stack);
      }
      throw toDataEngineHttpError(err);
    }
  }
}
