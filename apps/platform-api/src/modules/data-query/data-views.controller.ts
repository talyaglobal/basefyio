import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DataQueryService } from './data-query.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

function nonNegativeInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException(`${name} must be a non-negative integer`);
  }
  return Number(raw);
}

/**
 * Views: saved Data Engine queries read as paginated documents
 * (`bf.data.view(name)` in the SDK).
 *
 * Same trust level as the query routes — the saved query runs against the
 * owner pool with no role switch — so the service key is required.
 */
@Controller('v1/projects/:projectId/views')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class DataViewsController {
  constructor(private readonly dataQuery: DataQueryService) {}

  @Get(':name')
  async readView(
    @Param('projectId') projectId: string,
    @Param('name') name: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
    @Query('cursor') cursorRaw?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const limit = nonNegativeInt(limitRaw, 'limit');
    if (limit === 0) throw new BadRequestException('limit must be between 1 and 1000');
    const offset = nonNegativeInt(cursorRaw, 'cursor') ?? nonNegativeInt(offsetRaw, 'offset');
    return this.dataQuery.executeView(projectId, name, { limit, offset }, user?.sub);
  }
}
