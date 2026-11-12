import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { BlueprintService, GenerateOptions } from './blueprint.service';
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
    return this.blueprint.getDetail(id, user?.sub);
  }

  /** Edit the draft: { name?, dataModel? }. */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { name?: unknown; dataModel?: unknown },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.update(id, body ?? {}, user?.sub);
  }

  /** Same as PATCH; both fields stay optional. */
  @Put(':id')
  replace(
    @Param('id') id: string,
    @Body() body: { name?: unknown; dataModel?: unknown },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.update(id, body ?? {}, user?.sub);
  }

  /** The SQL "Generate tables" would run (?access=service_role|authenticated_read|authenticated_write). */
  @Get(':id/schema')
  schema(
    @Param('id') id: string,
    @Query('access') access: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.schemaPreview(id, access, user?.sub);
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
    @Body() body: GenerateOptions,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.generate(id, body ?? {}, user?.sub);
  }

  @Post(':id/resync')
  resync(
    @Param('id') id: string,
    @Body() body: { sheets: AnalyzeBlueprintInput['sheets']; name?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.blueprint.resync(id, body, user?.sub);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.blueprint.remove(id, user?.sub);
  }
}
