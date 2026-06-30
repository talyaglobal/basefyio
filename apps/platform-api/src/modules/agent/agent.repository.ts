import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle/drizzle.module';
import type { DrizzleDb } from '../../db/drizzle/client';
import {
  chatThreads,
  chatMessages,
  agentMemory,
  agentToolCalls,
  agentPolicyEvents,
  type ChatThread,
  type ChatMessage,
  type AgentMemory,
  type AgentToolCall,
  type AgentPolicyEvent,
} from '../../db/drizzle/schema/agent-memory';
import {
  agentRunAttachments,
  type AgentRunAttachment,
  type AttachmentKind,
} from '../../db/drizzle/schema/agent-attachments';

export interface CreateThreadInput {
  projectId: string;
  agentId?: string | null;
  title?: string | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AddMessageInput {
  threadId: string;
  projectId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tokenCount?: number | null;
  metadata?: { toolName?: string; toolCallId?: string; [k: string]: unknown } | null;
}

export interface RecordToolCallInput {
  runId?: string | null;
  threadId?: string | null;
  projectId: string;
  toolId: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  status: 'allowed' | 'denied' | 'success' | 'failed';
  latencyMs?: number | null;
  deniedReason?: string | null;
}

export interface RecordPolicyEventInput {
  runId?: string | null;
  toolCallId?: string | null;
  projectId: string;
  decision: 'allow' | 'deny';
  reasonCode?: string | null;
  matchedRule?: string | null;
}

export interface RecordAttachmentInput {
  runId: string;
  projectId: string;
  step: number;
  toolCallId?: string | null;
  kind: AttachmentKind;
  content: Record<string, unknown>;
}

@Injectable()
export class AgentRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Threads ───────────────────────────────────────────

  async createThread(input: CreateThreadInput): Promise<ChatThread> {
    const [row] = await this.db
      .insert(chatThreads)
      .values({
        projectId: input.projectId,
        agentId: input.agentId ?? null,
        title: input.title ?? null,
        createdBy: input.createdBy ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();
    return row;
  }

  async getThread(
    projectId: string,
    threadId: string,
  ): Promise<ChatThread | null> {
    const rows = await this.db
      .select()
      .from(chatThreads)
      .where(
        and(eq(chatThreads.id, threadId), eq(chatThreads.projectId, projectId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listThreads(
    projectId: string,
    opts: { agentId?: string; limit: number; offset: number },
  ): Promise<{ threads: ChatThread[]; total: number }> {
    const conditions = [eq(chatThreads.projectId, projectId)];
    if (opts.agentId) {
      conditions.push(eq(chatThreads.agentId, opts.agentId));
    }
    const where = and(...conditions);

    const [rows, [countRow]] = await Promise.all([
      this.db
        .select()
        .from(chatThreads)
        .where(where)
        .orderBy(desc(chatThreads.updatedAt))
        .limit(opts.limit)
        .offset(opts.offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(chatThreads)
        .where(where),
    ]);

    return { threads: rows, total: countRow.count };
  }

  // ── Messages ──────────────────────────────────────────

  async addMessage(input: AddMessageInput): Promise<ChatMessage> {
    const [row] = await this.db
      .insert(chatMessages)
      .values({
        threadId: input.threadId,
        projectId: input.projectId,
        role: input.role,
        content: input.content,
        tokenCount: input.tokenCount ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();

    // Bump thread updatedAt so listThreads sorts correctly.
    await this.db
      .update(chatThreads)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(chatThreads.id, input.threadId),
          eq(chatThreads.projectId, input.projectId),
        ),
      );

    return row;
  }

  async listMessages(
    projectId: string,
    threadId: string,
    opts: { limit: number; offset: number },
  ): Promise<ChatMessage[]> {
    return this.db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.projectId, projectId),
        ),
      )
      .orderBy(chatMessages.createdAt)
      .limit(opts.limit)
      .offset(opts.offset);
  }

  // ── Memory ────────────────────────────────────────────

  async listMemory(
    projectId: string,
    opts: { agentId?: string; limit?: number },
  ): Promise<AgentMemory[]> {
    const conditions = [eq(agentMemory.projectId, projectId)];
    if (opts.agentId) {
      conditions.push(eq(agentMemory.agentId, opts.agentId));
    }
    return this.db
      .select()
      .from(agentMemory)
      .where(and(...conditions))
      .orderBy(desc(agentMemory.createdAt))
      .limit(opts.limit ?? 50);
  }

  // ── Tool calls ────────────────────────────────────────

  async recordToolCall(input: RecordToolCallInput): Promise<AgentToolCall> {
    const [row] = await this.db
      .insert(agentToolCalls)
      .values({
        runId: input.runId ?? null,
        threadId: input.threadId ?? null,
        projectId: input.projectId,
        toolId: input.toolId,
        input: input.input,
        output: input.output ?? null,
        status: input.status,
        latencyMs: input.latencyMs ?? null,
        deniedReason: input.deniedReason ?? null,
      })
      .returning();
    return row;
  }

  async recordPolicyEvent(
    input: RecordPolicyEventInput,
  ): Promise<AgentPolicyEvent> {
    const [row] = await this.db
      .insert(agentPolicyEvents)
      .values({
        runId: input.runId ?? null,
        toolCallId: input.toolCallId ?? null,
        projectId: input.projectId,
        decision: input.decision,
        reasonCode: input.reasonCode ?? null,
        matchedRule: input.matchedRule ?? null,
      })
      .returning();
    return row;
  }

  // ── Attachments ───────────────────────────────────────

  async recordAttachment(
    input: RecordAttachmentInput,
  ): Promise<AgentRunAttachment> {
    const [row] = await this.db
      .insert(agentRunAttachments)
      .values({
        runId: input.runId,
        projectId: input.projectId,
        step: input.step,
        toolCallId: input.toolCallId ?? null,
        kind: input.kind,
        content: input.content,
      })
      .returning();
    return row;
  }
}
