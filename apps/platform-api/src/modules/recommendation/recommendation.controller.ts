import {
  Controller,
  Get,
  Query,
  UseGuards,
  ParseIntPipe,
  Optional,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { RecommendationService } from './recommendation.service';

@Controller('recommendations')
@UseGuards(JwtAuthGuard)
export class RecommendationController {
  constructor(private readonly recommendationService: RecommendationService) {}

  /**
   * Returns SQL queries similar to the given query within the same project.
   * GET /recommendations/similar-queries?projectId=...&query=SELECT+*+FROM+users
   */
  @Get('similar-queries')
  getSimilarQueries(
    @CurrentUser() user: JwtPayload,
    @Query('projectId') projectId: string,
    @Query('query') query: string,
    @Query('limit') limit?: string,
  ) {
    return this.recommendationService.getSimilarQueries(
      user.sub,
      projectId,
      query,
      limit ? parseInt(limit, 10) : 5,
    );
  }

  /**
   * Returns SQL patterns from other projects in the same team.
   * GET /recommendations/related-patterns?teamId=...&query=...
   */
  @Get('related-patterns')
  getRelatedPatterns(
    @CurrentUser() user: JwtPayload,
    @Query('teamId') teamId: string,
    @Query('query') query: string,
    @Query('limit') limit?: string,
  ) {
    return this.recommendationService.getRelatedPatterns(
      user.sub,
      teamId,
      query,
      limit ? parseInt(limit, 10) : 3,
    );
  }

  /**
   * Trigger a user session embedding index for the current user/project.
   * Call this on SQL editor open. Fire-and-forget on the client.
   * GET /recommendations/index-session?projectId=...
   */
  @Get('index-session')
  indexSession(
    @CurrentUser() user: JwtPayload,
    @Query('projectId') projectId: string,
  ) {
    // Non-blocking — client does not need to wait for this
    this.recommendationService
      .indexUserSession(user.sub, projectId)
      .catch(() => {});
    return { ok: true };
  }
}
