import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AgentService } from './agent.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { CreateThreadDto } from './dto/create-thread.dto';
import { AddMessageDto } from './dto/add-message.dto';
import { ListThreadsQuery } from './dto/list-threads.query';
import { ListMessagesQuery } from './dto/list-messages.query';

@Controller('v1/projects/:projectId/agents/:agentId')
@UseGuards(JwtOrApiKeyGuard)
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  // ── Threads ───────────────────────────────────────────

  @Post('threads')
  async createThread(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Body() body: CreateThreadDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agent.createThread(projectId, user?.sub, agentId, body);
  }

  @Get('threads')
  async listThreads(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Query() query: ListThreadsQuery,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agent.listThreads(projectId, user?.sub, agentId, query);
  }

  @Get('threads/:threadId')
  async getThread(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Param('threadId') threadId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agent.getThread(projectId, user?.sub, agentId, threadId);
  }

  // ── Messages ──────────────────────────────────────────

  @Get('threads/:threadId/messages')
  async listMessages(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Param('threadId') threadId: string,
    @Query() query: ListMessagesQuery,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agent.listMessages(projectId, user?.sub, agentId, threadId, query);
  }

  @Post('threads/:threadId/messages')
  async addMessage(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @Param('threadId') threadId: string,
    @Body() body: AddMessageDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agent.addMessage(projectId, user?.sub, agentId, threadId, body);
  }

  // ── Memory ────────────────────────────────────────────

  @Get('memory')
  async listMemory(
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.agent.listMemory(projectId, user?.sub, agentId);
  }
}
