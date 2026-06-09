import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { RagService } from './rag.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { RegisterRagDocumentDto } from './dto/register-rag-document.dto';
import { ListRagDocumentsQuery } from './dto/list-rag-documents.query';
import { ReindexDto } from './dto/reindex.dto';
import { RagSearchQuery } from './dto/rag-search.query';

@Controller('projects/:projectId/rag')
@UseGuards(JwtOrApiKeyGuard)
export class RagController {
  constructor(private readonly rag: RagService) {}

  // ── Documents ──────────────────────────────────────────

  @Post('documents')
  async registerDocument(
    @Param('projectId') projectId: string,
    @Body() body: RegisterRagDocumentDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.rag.registerDocument(projectId, user?.sub, body);
  }

  @Get('documents')
  async listDocuments(
    @Param('projectId') projectId: string,
    @Query() query: ListRagDocumentsQuery,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.rag.listDocuments(projectId, user?.sub, query);
  }

  // ── Index control ──────────────────────────────────────

  @Get('index/status')
  async indexStatus(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.rag.getIndexStatus(projectId, user?.sub);
  }

  @Post('index/reindex')
  async reindex(
    @Param('projectId') projectId: string,
    @Body() body: ReindexDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.rag.reindex(projectId, user?.sub, body);
  }

  @Post('index/reindex-incomplete')
  async reindexIncomplete(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.rag.reindexIncomplete(projectId, user?.sub);
  }

  // ── Search / usage ─────────────────────────────────────

  @Get('search')
  async search(
    @Param('projectId') projectId: string,
    @Query() query: RagSearchQuery,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.rag.search(projectId, user?.sub, query);
  }

  @Get('usage')
  async usage(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.rag.usage(projectId, user?.sub);
  }
}
