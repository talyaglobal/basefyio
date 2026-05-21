import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';
import { TenantEmbeddingService } from './tenant-embedding.service';

@Controller('rest/v1/embeddings')
@UseGuards(ApiKeyGuard)
export class TenantEmbeddingPublicController {
  constructor(private readonly tenantEmbedding: TenantEmbeddingService) {}

  /**
   * Store a text chunk with its embedding.
   * Requires: service_role or authenticated role.
   *
   * POST /rest/v1/embeddings
   * Body: { content, namespace?, metadata? }
   */
  @Post()
  async store(
    @Body()
    body: {
      content: string;
      namespace?: string;
      metadata?: Record<string, unknown>;
    },
    @Req() req: Request,
  ) {
    const payload = this.getPayload(req);
    this.assertWriteAccess(payload);
    return this.tenantEmbedding.store(payload.projectId, body);
  }

  /**
   * Store multiple text chunks in one call.
   * Requires: service_role or authenticated role.
   *
   * POST /rest/v1/embeddings/batch
   * Body: { items: [{ content, namespace?, metadata? }, ...] }
   */
  @Post('batch')
  async storeBatch(
    @Body()
    body: {
      items: Array<{
        content: string;
        namespace?: string;
        metadata?: Record<string, unknown>;
      }>;
    },
    @Req() req: Request,
  ) {
    const payload = this.getPayload(req);
    this.assertWriteAccess(payload);
    return this.tenantEmbedding.storeBatch(payload.projectId, body.items);
  }

  /**
   * Semantic search across stored embeddings.
   * Available to all roles (anon, authenticated, service_role).
   *
   * POST /rest/v1/embeddings/search
   * Body: { query, namespace?, threshold?, limit?, filter? }
   */
  @Post('search')
  async search(
    @Body()
    body: {
      query: string;
      namespace?: string;
      threshold?: number;
      limit?: number;
      filter?: Record<string, unknown>;
    },
    @Req() req: Request,
  ) {
    const payload = this.getPayload(req);
    return this.tenantEmbedding.search(payload.projectId, body);
  }

  /**
   * Delete embeddings by IDs.
   * Requires: service_role or authenticated role.
   *
   * DELETE /rest/v1/embeddings
   * Body: { ids: ["uuid1", "uuid2"] }
   */
  @Delete()
  async deleteByIds(
    @Body() body: { ids: string[] },
    @Req() req: Request,
  ) {
    const payload = this.getPayload(req);
    this.assertWriteAccess(payload);
    const deleted = await this.tenantEmbedding.deleteByIds(
      payload.projectId,
      body.ids,
    );
    return { deleted };
  }

  /**
   * Delete all embeddings in a namespace.
   * Requires: service_role.
   *
   * DELETE /rest/v1/embeddings/namespace/:namespace
   */
  @Delete('namespace')
  async deleteByNamespace(
    @Body() body: { namespace: string },
    @Req() req: Request,
  ) {
    const payload = this.getPayload(req);
    if (payload.role !== 'service') {
      throw new ForbiddenException(
        'Namespace deletion requires service_role key',
      );
    }
    const deleted = await this.tenantEmbedding.deleteByNamespace(
      payload.projectId,
      body.namespace,
    );
    return { deleted };
  }

  /**
   * Get embedding status for the project.
   *
   * GET /rest/v1/embeddings/status
   */
  @Get('status')
  async status(@Req() req: Request) {
    const payload = this.getPayload(req);
    return this.tenantEmbedding.getStatus(payload.projectId);
  }

  private getPayload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new ForbiddenException('API key required');
    return payload;
  }

  private assertWriteAccess(payload: ApiKeyPayload): void {
    if (payload.dbRole === 'anon') {
      throw new ForbiddenException(
        'Write access requires authenticated or service_role key',
      );
    }
  }
}
