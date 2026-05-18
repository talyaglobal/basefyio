import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search.dto';

@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * Hybrid semantic + keyword search across all indexed content
   * (SQL history, project schemas, activity logs, feedback).
   *
   * GET /search?q=users+table&projectId=...&limit=20
   */
  @Get()
  search(@CurrentUser() user: JwtPayload, @Query() dto: SearchQueryDto) {
    return this.searchService.search({
      userId: user.sub,
      query: dto.q,
      projectId: dto.projectId,
      teamId: dto.teamId,
      entityTypes: dto.entityTypes,
      limit: dto.limit ?? 20,
    });
  }
}
