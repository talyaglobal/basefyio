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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantEmbeddingService } from './tenant-embedding.service';
import { SetEmbeddingProviderDto } from './dto/set-embedding-provider.dto';
import { assertProjectTeamMember } from './tenant-embedding.access';

@Controller('projects/:projectId/embeddings')
@UseGuards(JwtAuthGuard)
export class TenantEmbeddingController {
  constructor(
    private readonly tenantEmbedding: TenantEmbeddingService,
    private readonly prisma: PrismaService,
  ) {}

  /** Get the pgvector / embedding status for a project. */
  @Get('status')
  async getStatus(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    return this.tenantEmbedding.getStatus(projectId);
  }

  /** Enable pgvector on the project's database (creates extension + tables). */
  @Post('enable')
  async enable(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    await this.tenantEmbedding.enablePgvector(projectId);
    return { message: 'pgvector enabled', projectId };
  }

  /** Disable pgvector for the project (tables are preserved). */
  @Delete('enable')
  async disable(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    await this.tenantEmbedding.disablePgvector(projectId);
    return { message: 'pgvector disabled', projectId };
  }

  /** Set or clear the per-project API key for the selected embedding provider. */
  @Post('api-key')
  async setApiKey(
    @Param('projectId') projectId: string,
    @Body() body: { apiKey: string | null },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    await this.tenantEmbedding.setEmbeddingApiKey(projectId, body.apiKey);
    return { message: body.apiKey ? 'API key set' : 'API key cleared' };
  }

  /** Providers the project may choose from, and which platform keys exist. */
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
  @Put('provider')
  async setProvider(
    @Param('projectId') projectId: string,
    @Body() body: SetEmbeddingProviderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertTeamMember(projectId, user.sub);
    return this.tenantEmbedding.setProvider(projectId, body);
  }

  /** Re-embed every stored vector with the project's current provider. */
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
