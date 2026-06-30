import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { BlueprintService } from './blueprint.service';
import { AnalyzeBlueprintInput, ApplicationModel } from './blueprint.types';

@Controller('blueprints')
@UseGuards(JwtAuthGuard)
export class BlueprintController {
  constructor(private readonly blueprint: BlueprintService) {}

  @Post('analyze')
  analyze(@Body() body: AnalyzeBlueprintInput, @CurrentUser() user: JwtPayload) {
    return this.blueprint.analyze(body, user?.sub);
  }

  @Get()
  list(@Query('teamId') teamId: string, @CurrentUser() user: JwtPayload) {
    return this.blueprint.list(teamId, user?.sub);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.blueprint.get(id, user?.sub);
  }

  @Patch(':id/approve')
  approve(
    @Param('id') id: string,
    @Body() body: { applicationModel: ApplicationModel },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.approve(id, body?.applicationModel, user?.sub);
  }

  @Post(':id/generate')
  generate(
    @Param('id') id: string,
    @Body() body: { projectId?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.generate(id, body?.projectId, user?.sub);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.blueprint.remove(id, user?.sub);
  }
}
