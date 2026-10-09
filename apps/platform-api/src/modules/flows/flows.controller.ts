import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { FlowsService } from './flows.service';
import { FlowDefinitionInput } from './flow.types';

/**
 * Automations.
  *
  * A flow holds URLs, headers and preconfigured actions including outbound
  * HTTP. Reading one discloses whatever it embeds; updating one repoints a live
  * automation, and triggering one spends money.
 */
@Controller('projects/:projectId/flows')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class FlowsController {
  constructor(private readonly flows: FlowsService) {}

  @Get()
  list(@Param('projectId') projectId: string, @CurrentUser() user?: JwtPayload) {
    return this.flows.list(projectId, user?.sub);
  }

  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() dto: FlowDefinitionInput,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.create(projectId, dto, user?.sub);
  }

  @Get(':id')
  get(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.get(projectId, id, user?.sub);
  }

  @Patch(':id')
  update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: FlowDefinitionInput,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.update(projectId, id, dto, user?.sub);
  }

  @Delete(':id')
  remove(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.remove(projectId, id, user?.sub);
  }

  @Post(':id/enable')
  enable(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.setEnabled(projectId, id, true, user?.sub);
  }

  @Post(':id/disable')
  disable(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.setEnabled(projectId, id, false, user?.sub);
  }

  @Post(':id/trigger')
  trigger(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { input?: unknown },
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.trigger(projectId, id, body?.input, user?.sub);
  }

  @Get(':id/runs')
  runs(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.runs(projectId, id, user?.sub);
  }
}
