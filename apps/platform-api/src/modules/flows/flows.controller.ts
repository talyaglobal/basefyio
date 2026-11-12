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
    @Body() dto: Partial<FlowDefinitionInput>,
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

  /** Newest first; `?limit=` (max 200) and `?before=<runId>` page further back. */
  @Get(':id/runs')
  runs(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.runs(projectId, id, user?.sub, { limit, before });
  }

  @Get(':id/runs/:runId')
  run(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.run(projectId, id, runId, user?.sub);
  }

  /** Start a new run with the same input as an earlier one. */
  @Post(':id/runs/:runId/rerun')
  rerun(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.rerun(projectId, id, runId, user?.sub);
  }

  /** New webhook URL + generated secret, or `{ "secret": "…" }` to set your own. */
  @Post(':id/webhook/rotate')
  rotateWebhook(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { secret?: unknown; keepUrl?: unknown },
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.rotateWebhook(projectId, id, body, user?.sub);
  }

  /** The one read path that returns the webhook secret. */
  @Post(':id/webhook/reveal')
  revealWebhook(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.revealWebhookSecret(projectId, id, user?.sub);
  }
}
