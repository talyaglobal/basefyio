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
import { AgentRunEventBus } from './agent-run-event-bus.service';
import type { CreateRunDto } from './dto/create-run.dto';
import { Inject } from '@nestjs/common';
import {
  TOOL_ADAPTERS_TOKEN,
  type ToolAdapter,
} from './tool-adapters/tool-adapter.interface';
import type { Agent, AgentVersion, AgentRun } from '../../db/drizzle/schema/agent-creation';

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface AgentRunResult {
  runId: string;
  agentId: string;
  status: 'completed' | 'failed';
  finalContent: string | null;
  stepCount: number;
  latencyMs: number;
  error?: string;
}

function writeSse(res: Response, event: SseEvent): void {
  res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

interface CoreParams {
  projectId: string;
  userId?: string;
  agentId: string;
  agent: Agent;
  version: AgentVersion;
  run: AgentRun;
  threadId: string | null;
  message?: string | null;
  allowMutating?: boolean;
  onEvent?: (e: SseEvent) => void;
}

@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  private readonly adapters: Map<string, ToolAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creationRepo: AgentCreationRepository,
    private readonly agentRepo: AgentRepository,
    private readonly policy: PolicyGatewayService,
    private readonly activity: ProjectActivityService,
    private readonly eventBus: AgentRunEventBus,
    @Inject(TOOL_ADAPTERS_TOKEN) adapters: ToolAdapter[],
  ) {
    this.adapters = new Map(adapters.map((a) => [a.toolId, a]));
  }

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

    const version = await this.creationRepo.getVersion(agentId, agent.currentVersionId);
    if (!version) throw new NotFoundException('Agent version not found');

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

    const emit = (e: SseEvent) => writeSse(res, e);

    try {
      const result = await this.executeCore({
        projectId,
        userId,
        agentId,
        agent,
        version,
        run,
        threadId,
        message: body.message,
        allowMutating: body.allowMutating,
        onEvent: emit,
      });

      await this.activity.append(projectId, {
        userId: userId ?? null,
        kind: ProjectActivityKind.AGENT_RUN_EXECUTED,
        title: `Agent "${agent.name}" run completed`,
        metadata: { runId: run.id, agentId, stepCount: result.stepCount, latencyMs: result.latencyMs },
      });
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  async runForFlow(
    projectId: string,
    agentId: string,
    opts: { message?: string; allowMutating?: boolean } = {},
  ): Promise<AgentRunResult> {
    const agent = await this.creationRepo.getAgent(projectId, agentId);
    if (!agent) throw new NotFoundException(`Agent '${agentId}' not found`);
    if (!agent.currentVersionId) {
      throw new BadRequestException('Agent has no active version');
    }
    if (agent.status === 'archived') {
      throw new BadRequestException('Cannot run an archived agent');
    }

    const version = await this.creationRepo.getVersion(agentId, agent.currentVersionId);
    if (!version) throw new NotFoundException('Agent version not found');

    const run = await this.creationRepo.createRun({
      agentId,
      agentVersionId: version.id,
      threadId: null,
      projectId,
    });

    return this.executeCore({
      projectId,
      agentId,
      agent,
      version,
      run,
      threadId: null,
      message: opts.message,
      allowMutating: opts.allowMutating,
    });
  }

  private async executeCore(params: CoreParams): Promise<AgentRunResult> {
    const {
      projectId,
      userId,
      agentId,
      agent,
      version,
      run,
      threadId,
      message,
      allowMutating,
      onEvent,
    } = params;

    const startMs = Date.now();

    onEvent?.({
      event: 'run_start',
      data: { runId: run.id, agentId, threadId, versionId: version.id },
    });

    if (threadId && message) {
      await this.agentRepo.addMessage({
        threadId,
        projectId,
        role: 'user',
        content: message,
      });
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (version.systemPrompt) {
      messages.push({ role: 'system', content: version.systemPrompt });
    }

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
    } else if (message) {
      messages.push({ role: 'user', content: message });
    }

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
      allowMutating: allowMutating ?? false,
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

        onEvent?.({
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

        if (choice.finish_reason === 'stop' || !assistantMsg.tool_calls?.length) {
          finalContent = assistantMsg.content ?? null;
          break;
        }

        for (const toolCall of assistantMsg.tool_calls ?? []) {
          const toolId = toolCall.function.name;
          let toolInput: Record<string, unknown> = {};
          try {
            toolInput = JSON.parse(toolCall.function.arguments ?? '{}');
          } catch {
            /* malformed arguments */
          }

          onEvent?.({
            event: 'tool_start',
            data: { toolCallId: toolCall.id, toolId, input: toolInput },
          });

          const decision = await this.policy.evaluate(toolId, policyCtx);
          const tcStart = Date.now();

          if (!decision.allowed) {
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

            onEvent?.({
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
              content: JSON.stringify({ error: 'TOOL_DENIED', reason: decision.reason }),
            });
            continue;
          }

          let output: Record<string, unknown> = {};
          let toolStatus: 'success' | 'failed' = 'success';
          const adapter = this.adapters.get(toolId);
          try {
            if (adapter) {
              const result = await adapter.execute(toolInput, {
                projectId,
                runId: run.id,
                step: stepCount,
                toolCallId: toolCall.id,
              });
              output = result.output;

              if (result.attachments?.length) {
                for (const att of result.attachments) {
                  await this.agentRepo.recordAttachment({
                    runId: run.id,
                    projectId,
                    step: stepCount,
                    toolCallId: toolCall.id,
                    kind: att.kind,
                    content: att.content,
                  });
                }
              }

              if (result.citations?.length) {
                onEvent?.({
                  event: 'citation',
                  data: {
                    step: stepCount,
                    toolCallId: toolCall.id,
                    toolId,
                    citations: result.citations,
                  },
                });
              }
            } else {
              output = { stub: true, toolId, message: 'Tool adapter not implemented' };
            }
          } catch (err: unknown) {
            toolStatus = 'failed';
            output = { error: err instanceof Error ? err.message : String(err) };
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

          onEvent?.({
            event: 'tool_end',
            data: { toolCallId: toolCall.id, toolId, status: toolStatus, output, latencyMs },
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(output),
          });
        }
      }

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

      onEvent?.({
        event: 'final',
        data: { content: finalContent, stepCount, latencyMs },
      });

      const result: AgentRunResult = {
        runId: run.id,
        agentId,
        status: 'completed',
        finalContent,
        stepCount,
        latencyMs,
      };

      this.eventBus.emitCompleted({
        runId: run.id,
        agentId,
        projectId,
        finalContent,
        stepCount,
        latencyMs,
      });

      return result;
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

      onEvent?.({
        event: 'error',
        data: { error: errorMsg, stepCount },
      });

      const result: AgentRunResult = {
        runId: run.id,
        agentId,
        status: 'failed',
        finalContent: null,
        stepCount,
        latencyMs,
        error: errorMsg,
      };

      this.eventBus.emitFailed({
        runId: run.id,
        agentId,
        projectId,
        error: errorMsg,
        stepCount,
        latencyMs,
      });

      return result;
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
