/**
 * Tests for AgentRunnerService.runForFlow() and AgentRunEventBus.
 *
 * OpenAI is mocked at module level so executeCore() never hits the network.
 */

jest.mock('openai', () => {
  const createFn = jest.fn();
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: createFn } },
    })),
    __createFn: createFn,
  };
});

import { AgentRunnerService } from './agent-runner.service';
import { AgentRunEventBus } from './agent-run-event-bus.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// Retrieve the shared createFn from the mocked module (set up when factory ran)
const openaiCreateFn: jest.Mock = (jest.requireMock('openai') as any).__createFn;

const AGENT_ID = 'agent-1';
const PROJECT_ID = 'proj-1';
const VERSION_ID = 'ver-1';
const RUN_ID = 'run-1';

const MOCK_AGENT = {
  id: AGENT_ID,
  projectId: PROJECT_ID,
  teamId: 'team-1',
  name: 'Test Agent',
  slug: 'test-agent',
  description: null,
  status: 'active' as const,
  currentVersionId: VERSION_ID,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_VERSION = {
  id: VERSION_ID,
  agentId: AGENT_ID,
  version: 1,
  systemPrompt: 'You are a helpful assistant.',
  model: 'gpt-4o',
  provider: 'openai' as const,
  temperature: 0.7,
  maxTokens: 512,
  maxSteps: 3,
  toolsConfig: { toolIds: [] },
  modelConfig: {},
  createdBy: null,
  createdAt: new Date(),
};

const MOCK_RUN = {
  id: RUN_ID,
  agentId: AGENT_ID,
  agentVersionId: VERSION_ID,
  threadId: null,
  projectId: PROJECT_ID,
  status: 'running' as const,
  stepCount: 0,
  latencyMs: null,
  errorCode: null,
  error: null,
  createdAt: new Date(),
  finishedAt: null,
};

function makeOpenAIReply(content: string) {
  return {
    choices: [
      {
        message: { role: 'assistant', content, tool_calls: undefined },
        finish_reason: 'stop',
      },
    ],
  };
}

function buildService(overrides: {
  getAgent?: jest.Mock;
  getVersion?: jest.Mock;
  createRun?: jest.Mock;
  patchRun?: jest.Mock;
  listEnabledTools?: jest.Mock;
}) {
  const eventBus = new AgentRunEventBus();
  const emitCompletedSpy = jest.spyOn(eventBus, 'emitCompleted');
  const emitFailedSpy = jest.spyOn(eventBus, 'emitFailed');

  const creationRepo = {
    getAgent: overrides.getAgent ?? jest.fn().mockResolvedValue(MOCK_AGENT),
    getVersion: overrides.getVersion ?? jest.fn().mockResolvedValue(MOCK_VERSION),
    createRun: overrides.createRun ?? jest.fn().mockResolvedValue(MOCK_RUN),
    patchRun: overrides.patchRun ?? jest.fn().mockResolvedValue(undefined),
    listEnabledTools: overrides.listEnabledTools ?? jest.fn().mockResolvedValue([]),
  };

  const agentRepo = {
    addMessage: jest.fn().mockResolvedValue(undefined),
    listMessages: jest.fn().mockResolvedValue([]),
    createThread: jest.fn(),
    getThread: jest.fn(),
    recordToolCall: jest.fn(),
    recordPolicyEvent: jest.fn(),
    recordAttachment: jest.fn(),
  };

  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID, teamId: 'team-1', status: 'ACTIVE' }),
    },
  };

  const svc = new AgentRunnerService(
    prisma as any,
    creationRepo as any,
    agentRepo as any,
    { evaluate: jest.fn().mockResolvedValue({ allowed: true }) } as any,
    { append: jest.fn().mockResolvedValue(undefined) } as any,
    eventBus,
    [],
  );

  return { svc, eventBus, emitCompletedSpy, emitFailedSpy, creationRepo, agentRepo };
}

beforeEach(() => {
  jest.clearAllMocks();
  openaiCreateFn.mockResolvedValue(makeOpenAIReply('Hello from agent'));
});

describe('AgentRunnerService.runForFlow', () => {
  it('throws NotFoundException when agent is not found', async () => {
    const { svc } = buildService({ getAgent: jest.fn().mockResolvedValue(null) });
    await expect(svc.runForFlow(PROJECT_ID, AGENT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequestException when agent has no active version', async () => {
    const { svc } = buildService({
      getAgent: jest.fn().mockResolvedValue({ ...MOCK_AGENT, currentVersionId: null }),
    });
    await expect(svc.runForFlow(PROJECT_ID, AGENT_ID)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws BadRequestException when agent is archived', async () => {
    const { svc } = buildService({
      getAgent: jest.fn().mockResolvedValue({ ...MOCK_AGENT, status: 'archived' }),
    });
    await expect(svc.runForFlow(PROJECT_ID, AGENT_ID)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns completed AgentRunResult and emits run.completed', async () => {
    const { svc, emitCompletedSpy } = buildService({});
    const result = await svc.runForFlow(PROJECT_ID, AGENT_ID, { message: 'Hi' });

    expect(result.status).toBe('completed');
    expect(result.runId).toBe(RUN_ID);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.finalContent).toBe('Hello from agent');
    expect(result.stepCount).toBe(1);
    expect(emitCompletedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, agentId: AGENT_ID, projectId: PROJECT_ID }),
    );
  });

  it('returns failed result and emits run.failed when LLM errors', async () => {
    openaiCreateFn.mockRejectedValue(new Error('LLM timeout'));
    const { svc, emitFailedSpy } = buildService({});

    const result = await svc.runForFlow(PROJECT_ID, AGENT_ID);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('LLM timeout');
    expect(emitFailedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, agentId: AGENT_ID }),
    );
  });

  it('patches run record to completed on success', async () => {
    const { svc, creationRepo } = buildService({});
    await svc.runForFlow(PROJECT_ID, AGENT_ID);
    expect(creationRepo.patchRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: 'completed' }));
  });

  it('patches run record to failed on LLM error', async () => {
    openaiCreateFn.mockRejectedValue(new Error('API error'));
    const { svc, creationRepo } = buildService({});
    await svc.runForFlow(PROJECT_ID, AGENT_ID);
    expect(creationRepo.patchRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: 'failed' }));
  });
});

describe('AgentRunEventBus', () => {
  it('emits and receives run.completed events', () => {
    const bus = new AgentRunEventBus();
    const handler = jest.fn();
    bus.onCompleted(handler);
    bus.emitCompleted({
      runId: 'r1', agentId: 'a1', projectId: 'p1',
      finalContent: 'done', stepCount: 2, latencyMs: 500,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }));
  });

  it('emits and receives run.failed events', () => {
    const bus = new AgentRunEventBus();
    const handler = jest.fn();
    bus.onFailed(handler);
    bus.emitFailed({
      runId: 'r2', agentId: 'a2', projectId: 'p2',
      error: 'timeout', stepCount: 1, latencyMs: 3000,
    });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ error: 'timeout' }));
  });

  it('does not cross-fire: completed handler does not receive failed events', () => {
    const bus = new AgentRunEventBus();
    const completedHandler = jest.fn();
    bus.onCompleted(completedHandler);
    bus.emitFailed({ runId: 'r3', agentId: 'a3', projectId: 'p3', error: 'x', stepCount: 0, latencyMs: 0 });
    expect(completedHandler).not.toHaveBeenCalled();
  });
});
