import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AgentCreationService } from './agent-creation.service';
import { AgentRunnerService } from './agent-runner.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { CreateAgentVersionDto } from './dto/create-agent-version.dto';
import { ListAgentsQuery } from './dto/list-agents.query';
import { CreateRunDto } from './dto/create-run.dto';
import { LinkDataSourceDto } from './dto/link-data-source.dto';

@Controller('v1/projects/:projectId/agents')
@UseGuards(JwtOrApiKeyGuard)
export class AgentCreationController {
  constructor(
    private readonly agentCreation: AgentCreationService,
    private readonly runner: AgentRunnerService,
  ) {}

  // ── Agents ────────────────────────────────────────────

  @Post()
  async createAgent(
    @Param('projectId') projectId: string,
    @Body() body: CreateAgentDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.createAgent(projectId, user?.sub, body);
  }

  @Get()
  async listAgents(
    @Param('projectId') projectId: string,
    @Query() query: ListAgentsQuery,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.listAgents(projectId, user?.sub, query);
  }

  @Get(':agentId')
  async getAgent(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.getAgent(projectId, user?.sub, agentId);
  }

  @Patch(':agentId')
  async updateAgent(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Body() body: UpdateAgentDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.updateAgent(
      projectId,
      user?.sub,
      agentId,
      body,
    );
  }

  // ── Versions ──────────────────────────────────────────

  @Post(':agentId/versions')
  async createVersion(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Body() body: CreateAgentVersionDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.createVersion(
      projectId,
      user?.sub,
      agentId,
      body,
    );
  }

  @Get(':agentId/versions')
  async listVersions(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.listVersions(projectId, user?.sub, agentId);
  }

  // ── Tools ─────────────────────────────────────────────

  @Get('-/tools')
  async listTools(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.listTools(projectId, user?.sub);
  }

  // ── Runs ──────────────────────────────────────────────

  @Post(':agentId/runs')
  async startRun(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Body() body: CreateRunDto,
    @Res() res: Response,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.runner.run(projectId, user?.sub, agentId, body, res);
  }

  @Post(':agentId/runs/:runId/cancel')
  async cancelRun(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Param('runId') runId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.cancelRun(
      projectId,
      user?.sub,
      agentId,
      runId,
    );
  }

  // ── Data Sources ──────────────────────────────────────

  @Get(':agentId/versions/:versionId/data-sources')
  async listDataSources(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.listDataSources(projectId, user?.sub, agentId, versionId);
  }

  @Post(':agentId/versions/:versionId/data-sources')
  async linkDataSource(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
    @Body() body: LinkDataSourceDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.linkDataSource(projectId, user?.sub, agentId, versionId, body);
  }

  @Delete(':agentId/versions/:versionId/data-sources/:dataStructureId')
  async unlinkDataSource(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
    @Param('dataStructureId') dataStructureId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agentCreation.unlinkDataSource(
      projectId,
      user?.sub,
      agentId,
      versionId,
      dataStructureId,
    );
  }
}
