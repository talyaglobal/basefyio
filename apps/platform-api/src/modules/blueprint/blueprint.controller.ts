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
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { BlueprintService } from './blueprint.service';
import { AnalyzeBlueprintInput, ApplicationModel, UpdateBlueprintInput } from './blueprint.types';

@Controller('blueprints')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class BlueprintController {
  constructor(private readonly blueprint: BlueprintService) {}

  @Scopes('blueprints:write')
  @Post('analyze')
  analyze(@Body() body: AnalyzeBlueprintInput, @CurrentUser() user: JwtPayload) {
    return this.blueprint.analyze(body, user?.sub);
  }

  @Scopes('blueprints:read')
  @Get()
  list(@Query('teamId') teamId: string, @CurrentUser() user: JwtPayload) {
    return this.blueprint.list(teamId, user?.sub);
  }

  @Scopes('blueprints:read')
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.blueprint.get(id, user?.sub);
  }

  @Scopes('blueprints:write')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateBlueprintInput,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.update(id, body, user?.sub);
  }

  @Scopes('blueprints:write')
  @Patch(':id/approve')
  approve(
    @Param('id') id: string,
    @Body() body: { applicationModel: ApplicationModel },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.approve(id, body?.applicationModel, user?.sub);
  }

  @Scopes('blueprints:write')
  @Post(':id/generate')
  generate(
    @Param('id') id: string,
    @Body() body: { projectId?: string; sheets?: AnalyzeBlueprintInput['sheets'] },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.generate(id, body?.projectId, user?.sub, body?.sheets);
  }

  @Scopes('blueprints:write')
  @Post(':id/resync')
  resync(
    @Param('id') id: string,
    @Body() body: { sheets: AnalyzeBlueprintInput['sheets']; name?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.resync(id, body, user?.sub);
  }

  @Scopes('blueprints:write')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.blueprint.remove(id, user?.sub);
  }
}
