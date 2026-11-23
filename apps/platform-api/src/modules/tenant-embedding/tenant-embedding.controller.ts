import {
  Controller,
  Post,
  Put,
  Delete,
  Get,
  Param,
  Body,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantEmbeddingService } from './tenant-embedding.service';
import { SetEmbeddingProviderDto } from './dto/set-embedding-provider.dto';
import { assertProjectTeamMember } from './tenant-embedding.access';
import { ProjectActivityKind, ProjectActivityService } from '../projects/project-activity.service';

@Controller('projects/:projectId/embeddings')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class TenantEmbeddingController {
  constructor(
    private readonly tenantEmbedding: TenantEmbeddingService,
    private readonly prisma: PrismaService,
    private readonly activity: ProjectActivityService,
  ) {}

  /** Embedding settings are part of the project log (#27); never fails the request. */
  private log(projectId: string, userId: string, kind: (typeof ProjectActivityKind)[keyof typeof ProjectActivityKind], title: string) {
    void this.activity.append(projectId, { userId, kind, title }).catch(() => undefined);
  }

  /** Get the pgvector / embedding status for a project. */
  @Scopes('embeddings:read')
  @Get('status')
  async getStatus(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    return this.tenantEmbedding.getStatus(projectId);
  }

  /** Enable pgvector on the project's database (creates extension + tables). */
  @Scopes('embeddings:write')
  @Post('enable')
  async enable(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    await this.tenantEmbedding.enablePgvector(projectId);
    this.log(projectId, user.sub, ProjectActivityKind.EMBEDDINGS_ENABLED, 'pgvector enabled');
    return { message: 'pgvector enabled', projectId };
  }

  /** Disable pgvector for the project (tables are preserved). */
  @Scopes('embeddings:write')
  @Delete('enable')
  async disable(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    await this.tenantEmbedding.disablePgvector(projectId);
    this.log(projectId, user.sub, ProjectActivityKind.EMBEDDINGS_DISABLED, 'pgvector disabled');
    return { message: 'pgvector disabled', projectId };
  }

  /** Set or clear the per-project API key for the selected embedding provider. */
  @Scopes('embeddings:write')
  @Post('api-key')
  async setApiKey(
    @Param('projectId') projectId: string,
    @Body() body: { apiKey: string | null },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    await this.tenantEmbedding.setEmbeddingApiKey(projectId, body.apiKey);
    // The key itself is never logged.
    this.log(projectId, user.sub, ProjectActivityKind.EMBEDDING_KEY_UPDATED, body.apiKey ? 'Embedding API key set' : 'Embedding API key cleared');
    return { message: body.apiKey ? 'API key set' : 'API key cleared' };
  }

  /** Providers the project may choose from, and which platform keys exist. */
  @Scopes('embeddings:read')
  @Get('providers')
  async providers(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    return this.tenantEmbedding.getProviderCatalogue();
  }

  /**
   * Switch the project's embedding provider / model / endpoint.
   * 409 with code EMBEDDING_MODEL_CHANGE_REQUIRES_REEMBED when vectors exist and
   * `reembed` was not confirmed; EMBEDDING_DIMENSION_TOO_LARGE when the model is
   * wider than the store.
   */
  @Scopes('embeddings:write')
  @Put('provider')
  async setProvider(
    @Param('projectId') projectId: string,
    @Body() body: SetEmbeddingProviderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    const result = await this.tenantEmbedding.setProvider(projectId, body);
    this.log(
      projectId,
      user.sub,
      ProjectActivityKind.EMBEDDING_PROVIDER_UPDATED,
      `Embedding provider set to ${body.provider ?? 'platform default'}${body.model ? ` (${body.model})` : ''}`,
    );
    return result;
  }

  /** Re-embed every stored vector with the project's current provider. */
  @Scopes('embeddings:write')
  @Post('reembed')
  @HttpCode(202)
  async reembed(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    return this.tenantEmbedding.startReembed(projectId);
  }

  private assertTeamMember(projectId: string, userId: string): Promise<void> {
    return assertProjectTeamMember(this.prisma, projectId, userId);
  }
}
