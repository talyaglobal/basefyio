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
} from '@nestjs/common';
import { DataEngineService } from './data-engine.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';

@Controller('v1/projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
export class DataEngineController {
  constructor(private readonly dataEngine: DataEngineService) {}

  // ── Entity Management ────────────────────────────────

  @Get('entities')
  async listEntities(
    @Param('projectId') projectId: string,
  ) {
    return this.dataEngine.listEntities(projectId);
  }

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

  @Post('data/:entity')
  async createRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.assertEngineAvailable();
    const col = await this.dataEngine.getEntityCollection(projectId, entity);
    return col.insert(body as any, { userId: user?.sub });
  }

  @Get('data/:entity')
  async listRecords(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Query('filter') filterRaw?: string,
    @Query('sort') sortRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    this.assertEngineAvailable();

    let col: Awaited<ReturnType<DataEngineService['getEntityCollection']>>;
    try {
      col = await this.dataEngine.getEntityCollection(projectId, entity);
    } catch (err: any) {
      if (err?.status) throw err; // Already an HTTP exception (404, etc.)
      throw new ServiceUnavailableException(
        `Data Engine error: ${err.message || 'Failed to resolve entity collection'}`,
      );
    }

    const filter = filterRaw ? JSON.parse(filterRaw) : undefined;
    const sort = sortRaw ? JSON.parse(sortRaw) : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : undefined;

    try {
      return await col.query({
        entity,
        filter,
        sort,
        limit,
        offset,
      });
    } catch (err: any) {
      if (err?.status) throw err;
      throw new ServiceUnavailableException(
        `Query failed: ${err.message || 'Unknown data engine error'}`,
      );
    }
  }

  @Get('data/:entity/:id')
  async getRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
  ) {
    this.assertEngineAvailable();
    const col = await this.dataEngine.getEntityCollection(projectId, entity);
    const doc = await col.get(id);
    if (!doc) throw new NotFoundException(`Document "${id}" not found`);
    return doc;
  }

  @Patch('data/:entity/:id')
  async updateRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.assertEngineAvailable();
    const col = await this.dataEngine.getEntityCollection(projectId, entity);
    return col.update(id, body as any, { userId: user?.sub });
  }

  @Put('data/:entity/:id')
  async replaceRecord(
    @Param('projectId') projectId: string,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user?: JwtPayload,
  ) {
    this.assertEngineAvailable();
    const col = await this.dataEngine.getEntityCollection(projectId, entity);
    return col.replace(id, body as any, { userId: user?.sub });
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
    const col = await this.dataEngine.getEntityCollection(projectId, entity);
    await col.delete(id, { userId: user?.sub });
  }

  // ── Health ───────────────────────────────────────────

  @Get('data-engine/health')
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
}
