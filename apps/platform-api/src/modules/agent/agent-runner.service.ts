import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { AgentCreationRepository } from './agent-creation.repository';
import { AgentRepository } from './agent.repository';
import { PolicyGatewayService, type PolicyContext } from './policy-gateway.service';
import type { CreateRunDto } from './dto/create-run.dto';

export interface SseEvent {
  event: string;
  data: unknown;
}

function writeSse(res: Response, event: SseEvent): void {
  res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

/**
 * Runner execution for Module 3 Commit 2.
 *
 * Flow per run:
 *  1. Resolve agent + active version, create agent_run row.
 *  2. Optionally create / reuse a chat_thread.
 *  3. Emit run_start SSE.
 *  4. Step loop (≤ maxSteps):
 *     a. Send accumulated messages to LLM.
 *     b. If assistant reply has no tool_calls → emit final, break.
 *     c. For each tool_call:
 *        - PolicyGateway.evaluate → record policy event.
 *        - If denied → emit tool_denied, add tool message, continue loop.
 *        - If allowed → execute tool stub, record tool call, emit tool_end.
 *     d. Append assistant + tool messages, emit step.
 *  5. Patch agent_run to completed/failed, emit done.
 *
 * Tool execution is stubbed: real tool adapters land in Module 4+.
 */
@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creationRepo: AgentCreationRepository,
    private readonly agentRepo: AgentRepository,
    private readonly policy: PolicyGatewayService,
    private readonly activity: ProjectActivityService,
  ) {}

  async run(
    projectId: string,
    userId: string | undefined,
    agentId: string,
    body: CreateRunDto,
    res: Response,
  ): Promise<void> {
    const project = await this.assertProjectAccess(projectId, userId);

    const agent = await this.creationRepo.getAgent(projectId, agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    if (!agent.currentVersionId) {
      throw new BadRequestException('Agent has no active version');
    }
    if (agent.status === 'archived') {
      throw new BadRequestException('Cannot run an archived agent');
    }

    const version = await this.creationRepo.getVersion(
      agentId,
      agent.currentVersionId,
    );
    if (!version) throw new NotFoundException('Agent version not found');

    // Resolve or create thread.
    let threadId: string | null = body.threadId ?? null;
    if (threadId) {
      const thread = await this.agentRepo.getThread(projectId, threadId);
      if (!thread) throw new NotFoundException('Thread not found');
    } else if (body.createThread !== false) {
      const thread = await this.agentRepo.createThread({
        projectId,
        agentId,
        title: body.threadTitle ?? null,
        createdBy: userId ?? null,
      });
      threadId = thread.id;
    }

    // Create run record.
    const run = await this.creationRepo.createRun({
      agentId,
      agentVersionId: version.id,
      threadId,
      projectId,
    });

    // SSE headers — must be set before any write.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const startMs = Date.now();

    writeSse(res, {
      event: 'run_start',
      data: { runId: run.id, agentId, threadId, versionId: version.id },
    });

    // Persist user message to thread.
    if (threadId && body.message) {
      await this.agentRepo.addMessage({
        threadId,
        projectId,
        role: 'user',
        content: body.message,
      });
    }

    // Build initial message array.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (version.systemPrompt) {
      messages.push({ role: 'system', content: version.systemPrompt });
    }

    // Load thread history if available.
    if (threadId) {
      const history = await this.agentRepo.listMessages(projectId, threadId, {
        limit: 50,
        offset: 0,
      });
      for (const m of history) {
        if (m.role === 'user' || m.role === 'assistant') {
          messages.push({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          });
        }
      }
    }

    // Resolve enabled tools for this version.
    const toolIds: string[] =
      (version.toolsConfig as { toolIds?: string[] } | null)?.toolIds ?? [];
    const enabledTools = await this.creationRepo.listEnabledTools();
    const allowedTools = enabledTools.filter((t) => toolIds.includes(t.toolId));
    const openaiTools: OpenAI.Chat.ChatCompletionTool[] = allowedTools.map(
      (t) => ({
        type: 'function',
        function: {
          name: t.toolId,
          description: t.description ?? '',
          parameters: (t.inputSchema as Record<string, unknown>) ?? {},
        },
      }),
    );

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? '',
      baseURL: this.resolveBaseUrl(version.provider),
    });

    const policyCtx: PolicyContext = {
      projectId,
      agentId,
      runId: run.id,
      threadId,
      allowMutating: body.allowMutating ?? false,
    };

    let stepCount = 0;
    const maxSteps = version.maxSteps ?? 10;
    let finalContent: string | null = null;

    try {
      while (stepCount < maxSteps) {
        const completion = await client.chat.completions.create({
          model: version.model,
          messages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          temperature: version.temperature ?? 0.7,
          max_tokens: version.maxTokens ?? 4096,
        });

        const choice = completion.choices[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        messages.push(assistantMsg);
        stepCount++;

        writeSse(res, {
          event: 'step',
          data: {
            step: stepCount,
            role: 'assistant',
            content: assistantMsg.content ?? null,
            toolCalls: assistantMsg.tool_calls?.map((tc) => ({
              id: tc.id,
              toolId: tc.function.name,
            })),
          },
        });

        if (
          choice.finish_reason === 'stop' ||
          !assistantMsg.tool_calls?.length
        ) {
          finalContent = assistantMsg.content ?? null;
          break;
        }

        // Process tool calls.
        for (const toolCall of assistantMsg.tool_calls ?? []) {
          const toolId = toolCall.function.name;
          let toolInput: Record<string, unknown> = {};
          try {
            toolInput = JSON.parse(toolCall.function.arguments ?? '{}');
          } catch {
            /* malformed arguments — pass empty object */
          }

          writeSse(res, {
            event: 'tool_start',
            data: { toolCallId: toolCall.id, toolId, input: toolInput },
          });

          const decision = await this.policy.evaluate(toolId, policyCtx);

          const tcStart = Date.now();

          if (!decision.allowed) {
            // Record denied tool call + policy event.
            const tc = await this.agentRepo.recordToolCall({
              runId: run.id,
              threadId,
              projectId,
              toolId,
              input: toolInput,
              status: 'denied',
              deniedReason: decision.reason,
            });
            await this.agentRepo.recordPolicyEvent({
              runId: run.id,
              toolCallId: tc.id,
              projectId,
              decision: 'deny',
              reasonCode: decision.reasonCode,
            });

            writeSse(res, {
              event: 'tool_denied',
              data: {
                toolCallId: toolCall.id,
                toolId,
                reason: decision.reason,
                reasonCode: decision.reasonCode,
              },
            });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                error: 'TOOL_DENIED',
                reason: decision.reason,
              }),
            });
            continue;
          }

          // Allowed — execute stub (real adapters in Module 4).
          let output: Record<string, unknown> = {};
          let toolStatus: 'success' | 'failed' = 'success';
          try {
            output = await this.executeToolStub(toolId, toolInput);
          } catch (err: unknown) {
            toolStatus = 'failed';
            output = {
              error: err instanceof Error ? err.message : String(err),
            };
          }

          const latencyMs = Date.now() - tcStart;

          const tc = await this.agentRepo.recordToolCall({
            runId: run.id,
            threadId,
            projectId,
            toolId,
            input: toolInput,
            output,
            status: toolStatus,
            latencyMs,
          });
          await this.agentRepo.recordPolicyEvent({
            runId: run.id,
            toolCallId: tc.id,
            projectId,
            decision: 'allow',
          });

          writeSse(res, {
            event: 'tool_end',
            data: {
              toolCallId: toolCall.id,
              toolId,
              status: toolStatus,
              output,
              latencyMs,
            },
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(output),
          });
        }
      }

      // Persist assistant reply to thread.
      if (threadId && finalContent !== null) {
        await this.agentRepo.addMessage({
          threadId,
          projectId,
          role: 'assistant',
          content: finalContent,
        });
      }

      const latencyMs = Date.now() - startMs;
      await this.creationRepo.patchRun(run.id, {
        status: 'completed',
        stepCount,
        latencyMs,
        finishedAt: new Date(),
      });

      await this.activity.append(projectId, {
        userId: userId ?? null,
        kind: ProjectActivityKind.AGENT_RUN_EXECUTED,
        title: `Agent "${agent.name}" run completed`,
        metadata: { runId: run.id, agentId, stepCount, latencyMs },
      });

      writeSse(res, {
        event: 'final',
        data: { content: finalContent, stepCount, latencyMs },
      });
    } catch (err: unknown) {
      const latencyMs = Date.now() - startMs;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Run ${run.id} failed: ${errorMsg}`);

      await this.creationRepo.patchRun(run.id, {
        status: 'failed',
        stepCount,
        latencyMs,
        error: errorMsg.slice(0, 512),
        finishedAt: new Date(),
      });

      writeSse(res, {
        event: 'error',
        data: { error: errorMsg, stepCount },
      });
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  private resolveBaseUrl(
    provider: 'openai' | 'nebius-private' | 'ollama' | undefined,
  ): string | undefined {
    switch (provider) {
      case 'nebius-private':
        return process.env.NEBIUS_API_BASE_URL ?? undefined;
      case 'ollama':
        return process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
      default:
        return undefined;
    }
  }

  /**
   * Stub executor — returns a placeholder until real tool adapters land.
   * Real adapters (RAG search, SQL executor, HTTP caller) are Module 4.
   */
  private async executeToolStub(
    toolId: string,
    _input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return { stub: true, toolId, message: 'Tool adapter not yet implemented' };
  }

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
