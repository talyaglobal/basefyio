import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { AgentCreationRepository } from './agent-creation.repository';
import type { CreateAgentDto } from './dto/create-agent.dto';
import type { UpdateAgentDto } from './dto/update-agent.dto';
import type { CreateAgentVersionDto } from './dto/create-agent-version.dto';
import type { ListAgentsQuery } from './dto/list-agents.query';

@Injectable()
export class AgentCreationService {
  private readonly logger = new Logger(AgentCreationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AgentCreationRepository,
    private readonly activity: ProjectActivityService,
  ) {}

  // ── Agents ────────────────────────────────────────────

  async createAgent(
    projectId: string,
    userId: string | undefined,
    body: CreateAgentDto,
  ) {
    const project = await this.assertProjectAccess(projectId, userId, 'ADMIN');

    const existing = await this.repo.getAgentBySlug(projectId, body.slug);
    if (existing) {
      throw new ConflictException(
        `Agent with slug "${body.slug}" already exists in this project`,
      );
    }

    const agent = await this.repo.createAgent({
      projectId,
      teamId: project.teamId,
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
      status: body.status ?? 'draft',
      createdBy: userId ?? null,
    });

    await this.activity.append(projectId, {
      userId: userId ?? null,
      kind: ProjectActivityKind.AGENT_CREATED,
      title: `Agent "${body.name}" created`,
      metadata: { agentId: agent.id, slug: agent.slug },
    });

    return agent;
  }

  async listAgents(
    projectId: string,
    userId: string | undefined,
    query: ListAgentsQuery,
  ) {
    await this.assertProjectAccess(projectId, userId);
    return this.repo.listAgents(projectId, {
      status: query.status,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
  }

  async getAgent(
    projectId: string,
    userId: string | undefined,
    agentId: string,
  ) {
    await this.assertProjectAccess(projectId, userId);
    const agent = await this.repo.getAgent(projectId, agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  async updateAgent(
    projectId: string,
    userId: string | undefined,
    agentId: string,
    body: UpdateAgentDto,
  ) {
    await this.assertProjectAccess(projectId, userId, 'ADMIN');
    const agent = await this.repo.getAgent(projectId, agentId);
    if (!agent) throw new NotFoundException('Agent not found');

    if (body.status && body.status !== agent.status) {
      if (agent.status === 'archived') {
        throw new BadRequestException('Archived agents cannot change status');
      }
      if (body.status === 'active' && !agent.currentVersionId) {
        throw new BadRequestException(
          'Agent must have at least one published version before activation',
        );
      }
    }

    await this.repo.patchAgent(projectId, agentId, {
      name: body.name,
      description: body.description ?? undefined,
      status: body.status,
    });

    return this.repo.getAgent(projectId, agentId);
  }

  // ── Versions ──────────────────────────────────────────

  async createVersion(
    projectId: string,
    userId: string | undefined,
    agentId: string,
    body: CreateAgentVersionDto,
  ) {
    await this.assertProjectAccess(projectId, userId, 'ADMIN');
    const agent = await this.repo.getAgent(projectId, agentId);
    if (!agent) throw new NotFoundException('Agent not found');

    const versionNum = await this.repo.nextVersionNumber(agentId);
    const version = await this.repo.createVersion({
      agentId,
      version: versionNum,
      systemPrompt: body.systemPrompt,
      model: body.model,
      provider: body.provider,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      maxSteps: body.maxSteps,
      toolsConfig: body.toolIds ? { toolIds: body.toolIds } : undefined,
      modelConfig: body.modelConfig,
      createdBy: userId ?? null,
    });

    // Promote to current version automatically.
    await this.repo.patchAgent(projectId, agentId, {
      currentVersionId: version.id,
    });

    return version;
  }

  async listVersions(
    projectId: string,
    userId: string | undefined,
    agentId: string,
  ) {
    await this.assertProjectAccess(projectId, userId);
    const agent = await this.repo.getAgent(projectId, agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    return this.repo.listVersions(agentId);
  }

  // ── Tools catalogue ───────────────────────────────────

  async listTools(projectId: string, userId: string | undefined) {
    await this.assertProjectAccess(projectId, userId);
    return this.repo.listEnabledTools();
  }

  // ── Runs (skeleton — execution in runner commit) ──────

  async cancelRun(
    projectId: string,
    userId: string | undefined,
    agentId: string,
    runId: string,
  ) {
    await this.assertProjectAccess(projectId, userId, 'ADMIN');
    const run = await this.repo.getRun(projectId, runId);
    if (!run) throw new NotFoundException('Run not found');
    if (run.agentId !== agentId) throw new NotFoundException('Run not found');

    if (run.status !== 'running') {
      throw new ConflictException(`Run is already ${run.status}`);
    }

    await this.repo.patchRun(runId, {
      status: 'cancelled',
      finishedAt: new Date(),
    });

    return { runId, status: 'cancelled' };
  }

  // ── Helpers ───────────────────────────────────────────

  private async assertProjectAccess(
    projectId: string,
    userId: string | undefined,
    minimumRole: 'MEMBER' | 'ADMIN' | 'OWNER' = 'MEMBER',
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

      const roleRank: Record<string, number> = { MEMBER: 0, ADMIN: 1, OWNER: 2 };
      if ((roleRank[membership.role] ?? -1) < (roleRank[minimumRole] ?? 0)) {
        throw new ForbiddenException(
          `This action requires ${minimumRole} role or above`,
        );
      }
    }
    return project;
  }
}
