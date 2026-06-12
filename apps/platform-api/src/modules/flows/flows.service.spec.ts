import { FlowsService } from './flows.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { FlowDefinition } from './types';

const PROJECT_ID = 'p-1';

function makePrisma() {
  const flows: FlowDefinition[] = [];
  return {
    appEntity: {
      findMany: jest.fn().mockImplementation(async () =>
        flows.map((f) => ({ entityName: `__flow__:${f.id}`, metadata: { flow: f } })),
      ),
      upsert: jest.fn().mockImplementation(async ({ create }: any) => {
        const flow = create.metadata.flow as FlowDefinition;
        const existing = flows.findIndex((f) => f.id === flow.id);
        if (existing >= 0) flows[existing] = flow;
        else flows.push(flow);
        return { id: 'e-1' };
      }),
    },
  };
}

describe('FlowsService', () => {
  it('createFlow: creates and persists a flow', async () => {
    const prisma = makePrisma();
    const queue = { add: jest.fn().mockResolvedValue({ id: 'j-1' }) };
    const svc = new FlowsService(prisma as any, queue as any);

    const flow = await svc.createFlow(PROJECT_ID, {
      name: 'Welcome email',
      trigger: { type: 'item.created', entityName: 'customers' },
      actions: [{ type: 'log', data: { msg: 'hello' } }],
    });

    expect(flow.id).toBeDefined();
    expect(flow.trigger.type).toBe('item.created');
    const list = await svc.listFlows(PROJECT_ID);
    expect(list).toHaveLength(1);
  });

  it('getFlow: throws 404 when not found', async () => {
    const prisma = makePrisma();
    const queue = { add: jest.fn() };
    const svc = new FlowsService(prisma as any, queue as any);
    await expect(svc.getFlow(PROJECT_ID, 'nonexistent')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('triggerFlow: throws 400 when flow is disabled', async () => {
    const prisma = makePrisma();
    const queue = { add: jest.fn().mockResolvedValue({ id: 'j-1' }) };
    const svc = new FlowsService(prisma as any, queue as any);
    const flow = await svc.createFlow(PROJECT_ID, {
      name: 'Disabled flow',
      trigger: { type: 'webhook' },
      actions: [],
    });
    await svc.enableFlow(PROJECT_ID, flow.id, false);
    await expect(svc.triggerFlow(PROJECT_ID, flow.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('executeFlow: runs log actions without error', async () => {
    const prisma = makePrisma();
    const queue = { add: jest.fn() };
    const svc = new FlowsService(prisma as any, queue as any);
    const flow = await svc.createFlow(PROJECT_ID, {
      name: 'Logger',
      trigger: { type: 'item.created', entityName: 'orders' },
      actions: [{ type: 'log', data: { event: 'item.created' } }],
    });
    const result = await svc.executeFlow(flow, { id: 'item-1', amount: 100 });
    expect(result.success).toBe(true);
    expect(result.actionsRun).toBe(1);
  });

  it('executeFlow: captures action errors without throwing', async () => {
    const prisma = makePrisma();
    const queue = { add: jest.fn() };
    const svc = new FlowsService(prisma as any, queue as any);
    const flow: FlowDefinition = {
      id: 'f-1', projectId: PROJECT_ID, name: 'Bad http', enabled: true,
      trigger: { type: 'webhook' },
      actions: [{ type: 'http.post' }], // missing url
      createdAt: '', updatedAt: '',
    };
    const result = await svc.executeFlow(flow, {});
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('http.post');
  });
});
