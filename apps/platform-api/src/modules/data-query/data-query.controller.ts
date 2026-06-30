import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DataQueryService } from './data-query.service';
import { ExecuteJsQueryDto } from './dto/execute-js-query.dto';
import { ExecuteAggregationDto } from './dto/execute-aggregation.dto';
import { SaveQueryDto } from './dto/save-query.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

@Controller('v1/projects/:projectId/data-query')
@UseGuards(JwtOrApiKeyGuard)
export class DataQueryController {
  constructor(private readonly dataQuery: DataQueryService) {}

  @Post('js')
  async executeJs(
    @Param('projectId') projectId: string,
    @Body() dto: ExecuteJsQueryDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataQuery.executeJs(projectId, dto.source, user?.sub, {
      page: dto.page,
      limit: dto.limit,
    });
  }

  @Post('aggregation')
  async executeAggregation(
    @Param('projectId') projectId: string,
    @Body() dto: ExecuteAggregationDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataQuery.executeAggregation(
      projectId,
      dto.entity,
      dto.pipeline,
      user?.sub,
    );
  }

  @Get('capabilities')
  async capabilities(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataQuery.getCapabilities(projectId, user?.sub);
  }

  @Get('saved')
  async listSaved(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataQuery.listSavedQueries(projectId, user?.sub);
  }

  @Post('saved')
  async createSaved(
    @Param('projectId') projectId: string,
    @Body() dto: SaveQueryDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataQuery.createSavedQuery(
      projectId,
      { name: dto.name, source: dto.source, entity: dto.entity, mode: dto.mode },
      user?.sub,
    );
  }

  @Delete('saved/:id')
  async deleteSaved(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataQuery.deleteSavedQuery(projectId, id, user?.sub);
  }
}
