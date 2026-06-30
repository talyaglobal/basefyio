import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantEmbeddingService } from './tenant-embedding.service';

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

  /** Set or clear a per-project OpenAI API key. */
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

  private async assertTeamMember(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { teamId: true },
    });
    if (!project) throw new Error('Project not found');

    const member = await this.prisma.teamMember.findFirst({
      where: { teamId: project.teamId, userId },
    });
    if (!member) throw new Error('Not a team member');
  }
}
