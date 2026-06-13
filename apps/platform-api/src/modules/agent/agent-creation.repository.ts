import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle/drizzle.module';
import type { DrizzleDb } from '../../db/drizzle/client';
import {
  agents,
  agentVersions,
  agentTools,
  agentRuns,
  agentVersionDataSources,
  type Agent,
  type AgentVersion,
  type AgentTool,
  type AgentRun,
  type AgentVersionDataSource,
} from '../../db/drizzle/schema/agent-creation';

export interface CreateAgentInput {
  projectId: string;
  teamId: string;
  name: string;
  slug: string;
  description?: string | null;
  status?: 'draft' | 'active' | 'archived';
  createdBy?: string | null;
}

export interface CreateVersionInput {
  agentId: string;
  version: number;
  systemPrompt: string;
  model: string;
  provider?: 'openai' | 'nebius-private' | 'ollama';
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  toolsConfig?: { toolIds: string[]; [k: string]: unknown };
  modelConfig?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface CreateRunInput {
  agentId: string;
  agentVersionId: string;
  threadId?: string | null;
  projectId: string;
}

@Injectable()
export class AgentCreationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Agents ────────────────────────────────────────────

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const [row] = await this.db
      .insert(agents)
      .values({
        projectId: input.projectId,
        teamId: input.teamId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        status: input.status ?? 'draft',
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return row;
  }

  async getAgent(projectId: string, agentId: string): Promise<Agent | null> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getAgentBySlug(
    projectId: string,
    slug: string,
  ): Promise<Agent | null> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.slug, slug), eq(agents.projectId, projectId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listAgents(
    projectId: string,
    opts: { status?: string; limit: number; offset: number },
  ): Promise<{ agents: Agent[]; total: number }> {
    const conditions = [eq(agents.projectId, projectId)];
    if (opts.status) {
      conditions.push(
        eq(agents.status, opts.status as 'draft' | 'active' | 'archived'),
      );
    }
    const where = and(...conditions);
    const [rows, [countRow]] = await Promise.all([
      this.db
        .select()
        .from(agents)
        .where(where)
        .orderBy(desc(agents.updatedAt))
        .limit(opts.limit)
        .offset(opts.offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(agents)
        .where(where),
    ]);
    return { agents: rows, total: countRow.count };
  }

  async patchAgent(
    projectId: string,
    agentId: string,
    patch: Partial<{
      name: string;
      description: string | null;
      status: 'draft' | 'active' | 'archived';
      currentVersionId: string | null;
    }>,
  ): Promise<void> {
    await this.db
      .update(agents)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)));
  }

  // ── Versions ──────────────────────────────────────────

  async createVersion(input: CreateVersionInput): Promise<AgentVersion> {
    const [row] = await this.db
      .insert(agentVersions)
      .values({
        agentId: input.agentId,
        version: input.version,
        systemPrompt: input.systemPrompt,
        model: input.model,
        provider: input.provider ?? 'openai',
        temperature: input.temperature ?? 0.7,
        maxTokens: input.maxTokens ?? 4096,
        maxSteps: input.maxSteps ?? 10,
        toolsConfig: input.toolsConfig ?? { toolIds: [] },
        modelConfig: input.modelConfig ?? {},
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return row;
  }

  async getVersion(
    agentId: string,
    versionId: string,
  ): Promise<AgentVersion | null> {
    const rows = await this.db
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.id, versionId),
          eq(agentVersions.agentId, agentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listVersions(agentId: string): Promise<AgentVersion[]> {
    return this.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId))
      .orderBy(desc(agentVersions.version));
  }

  async nextVersionNumber(agentId: string): Promise<number> {
    const [row] = await this.db
      .select({ max: sql<number>`coalesce(max(${agentVersions.version}), 0)` })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId));
    return (row?.max ?? 0) + 1;
  }

  // ── Tools ─────────────────────────────────────────────

  async listEnabledTools(): Promise<AgentTool[]> {
    return this.db
      .select()
      .from(agentTools)
      .where(eq(agentTools.enabled, true))
      .orderBy(agentTools.toolId);
  }

  async getTool(toolId: string): Promise<AgentTool | null> {
    const rows = await this.db
      .select()
      .from(agentTools)
      .where(eq(agentTools.toolId, toolId))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Runs ──────────────────────────────────────────────

  async createRun(input: CreateRunInput): Promise<AgentRun> {
    const [row] = await this.db
      .insert(agentRuns)
      .values({
        agentId: input.agentId,
        agentVersionId: input.agentVersionId,
        threadId: input.threadId ?? null,
        projectId: input.projectId,
        status: 'running',
      })
      .returning();
    return row;
  }

  async patchRun(
    runId: string,
    patch: Partial<{
      status: 'running' | 'completed' | 'failed' | 'cancelled';
      stepCount: number;
      latencyMs: number | null;
      errorCode: string | null;
      error: string | null;
      finishedAt: Date | null;
    }>,
  ): Promise<void> {
    await this.db
      .update(agentRuns)
      .set(patch)
      .where(eq(agentRuns.id, runId));
  }

  async getRun(projectId: string, runId: string): Promise<AgentRun | null> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, runId), eq(agentRuns.projectId, projectId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Data Sources ──────────────────────────────────────

  async listDataSources(agentVersionId: string): Promise<AgentVersionDataSource[]> {
    return this.db
      .select()
      .from(agentVersionDataSources)
      .where(eq(agentVersionDataSources.agentVersionId, agentVersionId))
      .orderBy(agentVersionDataSources.createdAt);
  }

  async linkDataSource(
    agentVersionId: string,
    dataStructureId: string,
    access: 'read' | 'write' = 'read',
  ): Promise<AgentVersionDataSource> {
    const [row] = await this.db
      .insert(agentVersionDataSources)
      .values({ agentVersionId, dataStructureId, access })
      .onConflictDoUpdate({
        target: [agentVersionDataSources.agentVersionId, agentVersionDataSources.dataStructureId],
        set: { access },
      })
      .returning();
    return row;
  }

  async unlinkDataSource(agentVersionId: string, dataStructureId: string): Promise<void> {
    await this.db
      .delete(agentVersionDataSources)
      .where(
        and(
          eq(agentVersionDataSources.agentVersionId, agentVersionId),
          eq(agentVersionDataSources.dataStructureId, dataStructureId),
        ),
      );
  }
}
