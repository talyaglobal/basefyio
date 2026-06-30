import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  Req,
  Headers,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { PublicCollectionApiService } from './public-collection-api.service';
import { RlsContext } from './public-api.service';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';

// Exempt from the global IP rate limiter (high-volume anonymous data API);
// still protected by the API-key guard.
@SkipThrottle()
@Controller('rest/v1/collections')
@UseGuards(ApiKeyGuard)
export class PublicCollectionApiController {
  constructor(
    private readonly collectionApi: PublicCollectionApiService,
  ) {}

  @Get(':collection')
  async findDocuments(
    @Param('collection') collection: string,
    @Req() req: Request,
    @Query('filter') filterRaw?: string,
    @Query('sort') sortRaw?: string,
    @Query('project') projectRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const payload = this.getPayload(req);
    const filter = filterRaw ? JSON.parse(filterRaw) : undefined;
    const sort = sortRaw ? JSON.parse(sortRaw) : undefined;
    const project = projectRaw ? JSON.parse(projectRaw) : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : undefined;

    return this.collectionApi.findDocuments(
      payload.projectId,
      collection,
      { filter, sort, project, limit, offset },
      this.buildCtx(payload),
    );
  }

  @Post(':collection')
  async insertDocuments(
    @Param('collection') collection: string,
    @Body() body: Record<string, unknown> | Record<string, unknown>[],
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.collectionApi.insertDocuments(
      payload.projectId,
      collection,
      body,
      returnRep,
      this.buildCtx(payload),
    );
  }

  @Get(':collection/:docId')
  async getDocument(
    @Param('collection') collection: string,
    @Param('docId') docId: string,
    @Req() req: Request,
  ) {
    const payload = this.getPayload(req);
    return this.collectionApi.findDocumentById(
      payload.projectId,
      collection,
      docId,
      this.buildCtx(payload),
    );
  }

  @Patch(':collection/:docId')
  async updateDocument(
    @Param('collection') collection: string,
    @Param('docId') docId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.collectionApi.updateDocument(
      payload.projectId,
      collection,
      docId,
      body,
      returnRep,
      this.buildCtx(payload),
    );
  }

  @Put(':collection/:docId')
  async replaceDocument(
    @Param('collection') collection: string,
    @Param('docId') docId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.collectionApi.replaceDocument(
      payload.projectId,
      collection,
      docId,
      body,
      returnRep,
      this.buildCtx(payload),
    );
  }

  @Delete(':collection/:docId')
  async deleteDocument(
    @Param('collection') collection: string,
    @Param('docId') docId: string,
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.collectionApi.deleteDocument(
      payload.projectId,
      collection,
      docId,
      returnRep,
      this.buildCtx(payload),
    );
  }

  private getPayload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new ForbiddenException('API key required');
    return payload;
  }

  private buildCtx(payload: ApiKeyPayload): RlsContext {
    return { role: payload.dbRole, jwtClaims: payload.jwtClaims };
  }
}
