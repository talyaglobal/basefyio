import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { AgentRepository } from './agent.repository';
import type { CreateThreadDto } from './dto/create-thread.dto';
import type { AddMessageDto } from './dto/add-message.dto';
import type { ListThreadsQuery } from './dto/list-threads.query';
import type { ListMessagesQuery } from './dto/list-messages.query';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AgentRepository,
    private readonly activity: ProjectActivityService,
  ) {}

  // ── Threads ───────────────────────────────────────────

  async createThread(
    projectId: string,
    userId: string | undefined,
    body: CreateThreadDto,
  ) {
    await this.assertProjectAccess(projectId, userId);
    const thread = await this.repo.createThread({
      projectId,
      agentId: body.agentId ?? null,
      title: body.title ?? null,
      createdBy: userId ?? null,
      metadata: body.metadata ?? null,
    });

    await this.activity.append({
      projectId,
      userId: userId ?? null,
      kind: ProjectActivityKind.AGENT_THREAD_CREATED,
      meta: { threadId: thread.id },
    });

    return thread;
  }

  async listThreads(
    projectId: string,
    userId: string | undefined,
    query: ListThreadsQuery,
  ) {
    await this.assertProjectAccess(projectId, userId);
    return this.repo.listThreads(projectId, {
      agentId: query.agentId,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
  }

  async getThread(
    projectId: string,
    userId: string | undefined,
    threadId: string,
  ) {
    await this.assertProjectAccess(projectId, userId);
    const thread = await this.repo.getThread(projectId, threadId);
    if (!thread) throw new NotFoundException('Thread not found');
    return thread;
  }

  // ── Messages ──────────────────────────────────────────

  async addMessage(
    projectId: string,
    userId: string | undefined,
    threadId: string,
    body: AddMessageDto,
  ) {
    await this.assertProjectAccess(projectId, userId);
    // Thread existence + project-scope check in one query.
    const thread = await this.repo.getThread(projectId, threadId);
    if (!thread) throw new NotFoundException('Thread not found');

    const message = await this.repo.addMessage({
      threadId,
      projectId,
      role: body.role,
      content: body.content,
      metadata: body.metadata ?? null,
    });

    if (body.role === 'user') {
      await this.activity.append({
        projectId,
        userId: userId ?? null,
        kind: ProjectActivityKind.AGENT_MESSAGE_ADDED,
        meta: { threadId, messageId: message.id },
      });
    }

    return message;
  }

  async listMessages(
    projectId: string,
    userId: string | undefined,
    threadId: string,
    query: ListMessagesQuery,
  ) {
    await this.assertProjectAccess(projectId, userId);
    const thread = await this.repo.getThread(projectId, threadId);
    if (!thread) throw new NotFoundException('Thread not found');

    return this.repo.listMessages(projectId, threadId, {
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  // ── Memory ────────────────────────────────────────────

  async listMemory(
    projectId: string,
    userId: string | undefined,
    agentId?: string,
  ) {
    await this.assertProjectAccess(projectId, userId);
    return this.repo.listMemory(projectId, { agentId });
  }

  // ── Internal helpers ──────────────────────────────────

  private async assertProjectAccess(
    projectId: string,
    userId: string | undefined,
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (userId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!membership) throw new ForbiddenException('Not a member of this team');
    }
    return project;
  }
}
