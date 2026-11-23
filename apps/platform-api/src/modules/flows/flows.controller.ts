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
import { ProjectActivityKind, ProjectActivityService } from '../projects/project-activity.service';

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
  constructor(
    private readonly flows: FlowsService,
    private readonly activity: ProjectActivityService,
  ) {}

  /** Flows are part of the project log (#27). Logging never fails the request. */
  private log(projectId: string, userId: string | undefined, kind: (typeof ProjectActivityKind)[keyof typeof ProjectActivityKind], title: string) {
    void this.activity.append(projectId, { userId, kind, title }).catch(() => undefined);
  }

  @Get()
  list(@Param('projectId') projectId: string, @CurrentUser() user?: JwtPayload) {
    return this.flows.list(projectId, user?.sub);
  }

  @Post()
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: FlowDefinitionInput,
    @CurrentUser() user?: JwtPayload,
  ) {
    const created = await this.flows.create(projectId, dto, user?.sub);
    this.log(projectId, user?.sub, ProjectActivityKind.FLOW_CREATED, `Flow created: ${created.name}`);
    return created;
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
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: FlowDefinitionInput,
    @CurrentUser() user?: JwtPayload,
  ) {
    const updated = await this.flows.update(projectId, id, dto, user?.sub);
    this.log(projectId, user?.sub, ProjectActivityKind.FLOW_UPDATED, `Flow updated: ${updated.name}`);
    return updated;
  }

  @Delete(':id')
  async remove(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const flow = await this.flows.get(projectId, id, user?.sub);
    const result = await this.flows.remove(projectId, id, user?.sub);
    this.log(projectId, user?.sub, ProjectActivityKind.FLOW_DELETED, `Flow deleted: ${flow.name}`);
    return result;
  }

  @Post(':id/enable')
  async enable(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const flow = await this.flows.setEnabled(projectId, id, true, user?.sub);
    this.log(projectId, user?.sub, ProjectActivityKind.FLOW_ENABLED, `Flow enabled: ${flow.name}`);
    return flow;
  }

  @Post(':id/disable')
  async disable(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const flow = await this.flows.setEnabled(projectId, id, false, user?.sub);
    this.log(projectId, user?.sub, ProjectActivityKind.FLOW_DISABLED, `Flow disabled: ${flow.name}`);
    return flow;
  }

  @Post(':id/trigger')
  async trigger(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { input?: unknown },
    @CurrentUser() user?: JwtPayload,
  ) {
    const run = await this.flows.trigger(projectId, id, body?.input, user?.sub);
    this.log(projectId, user?.sub, ProjectActivityKind.FLOW_TRIGGERED, `Flow run started (${run.runId})`);
    return run;
  }

  /**
   * Rotate the webhook secret for a webhook-triggered flow.
   * Returns the new secret once — store it immediately as it cannot be retrieved again.
   */
  @Post(':id/rotate-webhook-secret')
  rotateWebhookSecret(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.flows.rotateWebhookSecret(projectId, id, user?.sub);
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
