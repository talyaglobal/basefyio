import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantEmbeddingService } from './tenant-embedding.service';
import { assertProjectTeamMember } from './tenant-embedding.access';

/**
 * What the customer can see about the AI processing of their project's data:
 * which provider and model embed their text, the vector width, the country the
 * text is sent to, and the provider's retention statement.
 */
@Controller('projects/:projectId/ai')
@UseGuards(JwtAuthGuard)
export class AiDisclosureController {
  constructor(
    private readonly tenantEmbedding: TenantEmbeddingService,
    private readonly prisma: PrismaService,
  ) {}

  /** GET /projects/:projectId/ai/disclosure */
  @Get('disclosure')
  async disclosure(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await assertProjectTeamMember(this.prisma, projectId, user.sub);
    return this.tenantEmbedding.getDisclosure(projectId);
  }
}
