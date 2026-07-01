import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementKey } from '../entitlement/entitlement-key';
import { FLOW_QUEUE } from '../queue/queue.module';
import {
  FlowAction,
  FlowDefinitionInput,
  FlowStepResult,
} from './flow.types';
import { assertSafeUrl } from './flow-url-guard';

const TRIGGER_TYPES = ['manual', 'webhook', 'schedule'];
const ACTION_TYPES = ['log', 'http.request'];

/**
 * Project automation flows: a trigger plus an ordered list of actions, executed
 * asynchronously on the BullMQ FLOW_QUEUE. Re-implemented from the askin "flows"
 * concept following our own patterns (no code copied).
 */
@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(FLOW_QUEUE) private readonly queue: Queue,
    private readonly projects: ProjectsService,
    private readonly entitlement: EntitlementService,
  ) {}

  private async assertProject(projectId: string, userId?: string): Promise<void> {
    // Throws if the project is missing or the user has no access.
    await this.projects.findOne(projectId, userId);
  }

  private validate(dto: FlowDefinitionInput): void {
    if (!dto?.name?.trim()) throw new BadRequestException('name is required');
    if (!dto.trigger || !TRIGGER_TYPES.includes(dto.trigger.type)) {
      throw new BadRequestException(`trigger.type must be one of ${TRIGGER_TYPES.join(', ')}`);
    }
    if (!Array.isArray(dto.actions) || dto.actions.length === 0) {
      throw new BadRequestException('at least one action is required');
    }
    for (const a of dto.actions) {
      if (!a || !ACTION_TYPES.includes(a.type)) {
        throw new BadRequestException(`action.type must be one of ${ACTION_TYPES.join(', ')}`);
      }
      if (a.type === 'http.request') {
        if (!a.url) throw new BadRequestException('http.request action requires a url');
        assertSafeUrl(a.url);
      }
    }
  }

  async list(projectId: string, userId?: string) {
    await this.assertProject(projectId, userId);
    return this.prisma.flow.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(projectId: string, id: string, userId?: string) {
    await this.assertProject(projectId, userId);
    const flow = await this.prisma.flow.findFirst({ where: { id, projectId } });
    if (!flow) throw new NotFoundException('Flow not found');
    return flow;
  }

  async create(projectId: string, dto: FlowDefinitionInput, userId?: string) {
    await this.assertProject(projectId, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.FLOWS);
    this.validate(dto);
    return this.prisma.flow.create({
      data: {
        projectId,
        name: dto.name.trim(),
        enabled: dto.enabled ?? true,
        trigger: dto.trigger as unknown as Prisma.InputJsonValue,
        actions: dto.actions as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async update(projectId: string, id: string, dto: FlowDefinitionInput, userId?: string) {
    await this.get(projectId, id, userId);
    this.validate(dto);
    return this.prisma.flow.update({
      where: { id },
      data: {
        name: dto.name.trim(),
        enabled: dto.enabled ?? true,
        trigger: dto.trigger as unknown as Prisma.InputJsonValue,
        actions: dto.actions as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async setEnabled(projectId: string, id: string, enabled: boolean, userId?: string) {
    await this.get(projectId, id, userId);
    return this.prisma.flow.update({ where: { id }, data: { enabled } });
  }

  async remove(projectId: string, id: string, userId?: string) {
    await this.get(projectId, id, userId);
    await this.prisma.flow.delete({ where: { id } });
    return { deleted: true };
  }

  async runs(projectId: string, id: string, userId?: string) {
    await this.get(projectId, id, userId);
    return this.prisma.flowRun.findMany({
      where: { flowId: id, projectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async trigger(projectId: string, id: string, input: unknown, userId?: string) {
    const flow = await this.get(projectId, id, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.FLOWS);
    if (!flow.enabled) throw new BadRequestException('Flow is disabled');
    const run = await this.prisma.flowRun.create({
      data: {
        flowId: flow.id,
        projectId,
        status: 'queued',
        input: (input ?? null) as Prisma.InputJsonValue,
      },
    });
    await this.queue.add(
      'execute',
      { flowRunId: run.id },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    return { runId: run.id, status: run.status };
  }

  /** Executes a queued run's actions in order. Called by the FLOW_QUEUE worker. */
  async execute(flowRunId: string): Promise<void> {
    const run = await this.prisma.flowRun.findUnique({
      where: { id: flowRunId },
      include: { flow: true },
    });
    if (!run) return;
    await this.prisma.flowRun.update({
      where: { id: run.id },
      data: { status: 'running', startedAt: new Date() },
    });

    const actions = (run.flow.actions as unknown as FlowAction[]) ?? [];
    const results: FlowStepResult[] = [];
    try {
      for (const action of actions) {
        const r = await this.runAction(action);
        results.push(r);
        if (!r.ok && !action.continueOnError) {
          throw new Error(r.detail || `action ${action.type} failed`);
        }
      }
      await this.prisma.flowRun.update({
        where: { id: run.id },
        data: {
          status: 'success',
          result: results as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.flowRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          result: results as unknown as Prisma.InputJsonValue,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
          finishedAt: new Date(),
        },
      });
      throw e; // surface to BullMQ so retry policy applies
    }
  }

  private async runAction(action: FlowAction): Promise<FlowStepResult> {
    if (action.type === 'log') {
      this.logger.log(`[flow] ${action.message ?? ''}`);
      return { type: 'log', ok: true, detail: action.message };
    }
    if (action.type === 'http.request') {
      if (!action.url) return { type: 'http.request', ok: false, detail: 'missing url' };
      assertSafeUrl(action.url);
      try {
        const res = await axios.request({
          method: action.method || 'POST',
          url: action.url,
          headers: action.headers,
          data: action.body,
          timeout: 10_000,
          // Do NOT follow redirects: a 3xx to a private/loopback host would
          // bypass the SSRF guard that only validated the original URL.
          maxRedirects: 0,
          validateStatus: () => true,
        });
        return { type: 'http.request', ok: res.status < 400, status: res.status };
      } catch (e) {
        return {
          type: 'http.request',
          ok: false,
          detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        };
      }
    }
    return { type: action.type, ok: false, detail: 'unknown action type' };
  }
}
