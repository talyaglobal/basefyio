import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { BlueprintService } from './blueprint.service';
import { AnalyzeBlueprintDto } from './dto/analyze-blueprint.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';

@Controller('v1/blueprints')
@UseGuards(JwtOrApiKeyGuard)
export class BlueprintController {
  constructor(private readonly service: BlueprintService) {}

  @Post('analyze')
  @HttpCode(HttpStatus.CREATED)
  analyze(@Body() dto: AnalyzeBlueprintDto, @CurrentUser() user: JwtPayload) {
    return this.service.analyze(user.sub, dto);
  }

  @Get('by-project/:projectId/build-package')
  @HttpCode(HttpStatus.OK)
  getBuildPackage(@Param('projectId') projectId: string) {
    return this.service.getBuildPackageForProject(projectId);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  getBlueprint(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.getBlueprint(user.sub, id);
  }

  @Patch(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.approve(user.sub, id, body);
  }

  @Post(':id/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  generate(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.generate(user.sub, id);
  }

  @Get(':id/status')
  getStatus(@Param('id') id: string) {
    return this.service.getGenerateStatus(id);
  }

  @Post('widgets')
  @HttpCode(HttpStatus.CREATED)
  saveWidget(
    @Body() body: {
      blueprintId: string;
      widgetLabel: string;
      chartHint: 'table' | 'bar' | 'line' | 'pie';
      sql: string;
      columns: string[];
      sampleData: Record<string, unknown>[];
    },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.saveWidget(user.sub, body);
  }
}
