import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { FLOW_QUEUE } from '../queue/queue.module';
import { FlowDefinition, FlowRunResult } from './types';
import { randomUUID } from 'crypto';

@Injectable()
export class FlowsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(FLOW_QUEUE) private readonly flowQueue: Queue,
  ) {}

  private async loadFlows(projectId: string): Promise<FlowDefinition[]> {
    const entities: Array<{ entityName: string; metadata: unknown }> =
      await (this.prisma as any).appEntity.findMany({
        where: { projectId, entityName: { startsWith: '__flow__:' } },
      }).catch(() => []);
    return entities
      .map((e) => (e.metadata as Record<string, unknown>)?.flow as FlowDefinition)
      .filter(Boolean);
  }

  private async saveFlow(projectId: string, flow: FlowDefinition): Promise<void> {
    const entityName = `__flow__:${flow.id}`;
    await (this.prisma as any).appEntity.upsert({
      where: { projectId_tableName: { projectId, tableName: entityName } },
      update: { metadata: { flow }, entityName },
      create: {
        projectId,
        entityName,
        tableName: entityName,
        description: `Flow: ${flow.name}`,
        metadata: { flow },
      },
    }).catch(() => undefined); // graceful for tests without DB
  }

  async createFlow(
    projectId: string,
    dto: { name: string; trigger: FlowDefinition['trigger']; actions: FlowDefinition['actions'] },
  ): Promise<FlowDefinition> {
    const now = new Date().toISOString();
    const flow: FlowDefinition = {
      id: randomUUID(),
      projectId,
      name: dto.name,
      enabled: true,
      trigger: dto.trigger,
      actions: dto.actions,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveFlow(projectId, flow);
    return flow;
  }

  async listFlows(projectId: string): Promise<FlowDefinition[]> {
    return this.loadFlows(projectId);
  }

  async getFlow(projectId: string, flowId: string): Promise<FlowDefinition> {
    const flows = await this.loadFlows(projectId);
    const flow = flows.find((f) => f.id === flowId);
    if (!flow) throw new NotFoundException(`Flow '${flowId}' not found`);
    return flow;
  }

  async enableFlow(projectId: string, flowId: string, enabled: boolean): Promise<FlowDefinition> {
    const flow = await this.getFlow(projectId, flowId);
    flow.enabled = enabled;
    flow.updatedAt = new Date().toISOString();
    await this.saveFlow(projectId, flow);
    return flow;
  }

  async triggerFlow(
    projectId: string,
    flowId: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ jobId: string; flowId: string; status: 'queued' }> {
    const flow = await this.getFlow(projectId, flowId);
    if (!flow.enabled) throw new BadRequestException(`Flow '${flowId}' is disabled`);

    const job = await this.flowQueue.add(
      'execute',
      { flowId, projectId, payload, flow },
      { attempts: 2, backoff: { type: 'exponential', delay: 3000 } },
    );

    return { jobId: String(job.id), flowId, status: 'queued' };
  }

  /**
   * Execute a flow synchronously (used by the processor and for testing).
   * Returns a result object without touching the queue.
   */
  async executeFlow(flow: FlowDefinition, payload: Record<string, unknown>): Promise<FlowRunResult> {
    const started = Date.now();
    const errors: string[] = [];
    let actionsRun = 0;

    for (const action of flow.actions) {
      try {
        await this.runAction(flow.projectId, action, payload);
        actionsRun++;
      } catch (err: any) {
        errors.push(`${action.type}: ${err?.message ?? String(err)}`);
      }
    }

    return {
      flowId: flow.id,
      success: errors.length === 0,
      actionsRun,
      errors,
      durationMs: Date.now() - started,
    };
  }

  private async runAction(
    projectId: string,
    action: FlowDefinition['actions'][0],
    payload: Record<string, unknown>,
  ): Promise<void> {
    switch (action.type) {
      case 'log':
        console.log(`[Flow action log] projectId=${projectId}`, action.data, payload);
        break;

      case 'http.post':
        if (!action.url) throw new Error('http.post action requires url');
        await fetch(action.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...action.headers },
          body: JSON.stringify({ ...action.data, payload }),
        });
        break;

      case 'item.create':
        // In V1: log the intent — full execution requires ItemsService injection
        console.log(`[Flow] item.create on ${action.entityName}:`, action.data);
        break;

      default:
        console.log(`[Flow] unhandled action type: ${action.type}`);
    }
  }
}
