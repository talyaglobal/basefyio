import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { ADVISOR_CATEGORIES, AdvisorCategory } from './advisor-rules';
import { AdvisorsService } from './advisors.service';

/**
 * Security and performance advisors of a project database (#218). Read-only:
 * catalog SELECTs only, the fix SQL is shown and never run. Team members may
 * read (checked by the service); tokens need `schema:read`.
 */
@Controller('projects/:id/advisors')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class AdvisorsController {
  constructor(private readonly advisors: AdvisorsService) {}

  @Scopes('schema:read')
  @Get()
  list(
    @Param('id') id: string,
    @CurrentUser() u: JwtPayload,
    @Query('category') category?: string,
    @Query('refresh') refresh?: string,
  ) {
    if (category !== undefined && category !== '' && !ADVISOR_CATEGORIES.includes(category as AdvisorCategory)) {
      throw new BadRequestException(`category must be one of: ${ADVISOR_CATEGORIES.join(', ')}`);
    }
    return this.advisors.scan(id, u.sub, {
      category: category ? (category as AdvisorCategory) : undefined,
      refresh: refresh === 'true' || refresh === '1',
    });
  }
}
