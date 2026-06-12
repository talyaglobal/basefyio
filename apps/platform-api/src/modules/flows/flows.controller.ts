import {
  Controller, Get, Post, Patch, Param, Body,
  HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { FlowsService } from './flows.service';
import { FlowDefinition } from './types';

@Controller('v1/projects/:projectId/flows')
@UseGuards(JwtOrApiKeyGuard)
export class FlowsController {
  constructor(private readonly service: FlowsService) {}

  @Get()
  list(@Param('projectId') projectId: string) {
    return this.service.listFlows(projectId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; trigger: FlowDefinition['trigger']; actions: FlowDefinition['actions'] },
  ) {
    return this.service.createFlow(projectId, body);
  }

  @Get(':flowId')
  getOne(@Param('projectId') projectId: string, @Param('flowId') flowId: string) {
    return this.service.getFlow(projectId, flowId);
  }

  @Patch(':flowId/enable')
  enable(@Param('projectId') projectId: string, @Param('flowId') flowId: string) {
    return this.service.enableFlow(projectId, flowId, true);
  }

  @Patch(':flowId/disable')
  disable(@Param('projectId') projectId: string, @Param('flowId') flowId: string) {
    return this.service.enableFlow(projectId, flowId, false);
  }

  @Post(':flowId/trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  trigger(
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.service.triggerFlow(projectId, flowId, payload);
  }
}
