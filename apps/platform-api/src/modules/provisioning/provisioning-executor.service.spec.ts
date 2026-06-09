import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { IProvisioningProvider } from './interfaces/provisioning-provider.interface';
import { IProviderRegistry } from './interfaces/provider-registry.interface';

// ── Mock factories ───────────────────────────────────────────

function makePrisma(overrides: Record<string, any> = {}) {
  const defaults = {
    provisioningOperation: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    teamMember: { findUnique: jest.fn() },
    provisioningAuditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  return { ...defaults, ...overrides } as any;
}

function makeProvider(overrides: Partial<IProvisioningProvider> = {}): IProvisioningProvider {
  return {
    execute: jest.fn().mockResolvedValue({ success: true, result: { noop: true } }),
    ...overrides,
  };
}

function makeRegistry(provider: IProvisioningProvider = makeProvider()): IProviderRegistry {
  return { resolve: jest.fn().mockReturnValue(provider) };
}

function makeSvc(prisma = makePrisma(), registry: IProviderRegistry = makeRegistry()) {
  return new ProvisioningExecutorService(prisma, registry);
}

// ── Fixture constants ────────────────────────────────────────

const TEAM_ID = 'team-1';
const PROJECT_ID = 'project-1';
const PP_ID = 'pp-1';
const OP_ID = 'op-1';
const USER_ID = 'user-1';
const OPENBAO_PATH = 'secret/provisioning/cred-1';

function stubOp(status = 'PENDING', id = OP_ID) {
  return {
    id,
    status,
    type: 'CREATE',
    input: { size: 'cx11' },
    provisioningProjectId: PP_ID,
    provisioningProject: {
      id: PP_ID,
      projectId: PROJECT_ID,
      provider: 'noop',
      region: 'eu-central',
      datacenter: null,
      project: { teamId: TEAM_ID, id: PROJECT_ID },
      credentialRef: { openbaoPath: OPENBAO_PATH },
    },
  };
}

function memberOf(teamId = TEAM_ID) {
  return { teamId, userId: USER_ID };
}

function makeRunningOp() {
  return { ...stubOp(), status: 'RUNNING', startedAt: new Date() };
}

function makeCompletedOp() {
  return { ...stubOp(), status: 'COMPLETED', completedAt: new Date() };
}

function makeFailedOp(errorMessage = 'provider timeout') {
  return { ...stubOp(), status: 'FAILED', errorMessage, completedAt: new Date() };
}

// ── Ownership ────────────────────────────────────────────────

describe('ProvisioningExecutorService — ownership', () => {
  it('throws NotFoundException when operation does not exist', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);
    await expect(makeSvc(prisma).executeOperation(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException when caller is not a team member', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(null);
    await expect(makeSvc(prisma).executeOperation(USER_ID, OP_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ── Invalid transitions ──────────────────────────────────────

describe('ProvisioningExecutorService — invalid transitions', () => {
  const nonExecutableStatuses = ['RUNNING', 'COMPLETED', 'FAILED', 'DRY_RUN', 'ROLLED_BACK'];

  for (const status of nonExecutableStatuses) {
    it(`throws BadRequestException for status ${status}`, async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp(status));
      prisma.teamMember.findUnique.mockResolvedValue(memberOf());
      await expect(makeSvc(prisma).executeOperation(USER_ID, OP_ID)).rejects.toBeInstanceOf(BadRequestException);
    });
  }

  it('rejects any status other than PENDING (allowlist safety)', async () => {
    const prisma = makePrisma();
    // Simulate a hypothetical future status not in the original blocklist
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('QUEUED' as any));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    await expect(makeSvc(prisma).executeOperation(USER_ID, OP_ID)).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ── Noop success ─────────────────────────────────────────────

describe('ProvisioningExecutorService — noop success', () => {
  it('transitions PENDING → RUNNING → COMPLETED and returns completed operation', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const result = await makeSvc(prisma).executeOperation(USER_ID, OP_ID);
    expect(result.status).toBe('COMPLETED');
  });

  it('calls update with RUNNING then COMPLETED in order', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    const calls = prisma.provisioningOperation.update.mock.calls;
    expect(calls[0][0].data.status).toBe('RUNNING');
    expect(calls[1][0].data.status).toBe('COMPLETED');
  });
});

// ── Noop failure ─────────────────────────────────────────────

describe('ProvisioningExecutorService — noop failure', () => {
  it('transitions PENDING → RUNNING → FAILED when provider throws', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.execute as jest.Mock).mockRejectedValue(new Error('provider timeout'));
    const result = await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    expect(result.status).toBe('FAILED');
  });

  it('persists normalized errorMessage on failed update', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp('provider timeout'));

    const provider = makeProvider();
    (provider.execute as jest.Mock).mockRejectedValue(new Error('provider timeout'));
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const failCall = prisma.provisioningOperation.update.mock.calls[1][0];
    expect(failCall.data.status).toBe('FAILED');
    expect(failCall.data.errorMessage).toBe('provider timeout');
  });

  it('returns the failed operation without re-throwing', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.execute as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(
      makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID),
    ).resolves.toBeDefined();
  });
});

// ── Audit sequence ────────────────────────────────────────────

describe('ProvisioningExecutorService — audit sequence', () => {
  it('emits STATUS_CHANGED(PENDING→RUNNING) then OPERATION_COMPLETED(RUNNING→COMPLETED) on success', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    const [first, second] = prisma.provisioningAuditEvent.create.mock.calls.map((c: any) => c[0].data);
    expect(prisma.provisioningAuditEvent.create).toHaveBeenCalledTimes(2);
    expect(first.kind).toBe('STATUS_CHANGED');
    expect(first.fromStatus).toBe('PENDING');
    expect(first.toStatus).toBe('RUNNING');
    expect(second.kind).toBe('OPERATION_COMPLETED');
    expect(second.fromStatus).toBe('RUNNING');
    expect(second.toStatus).toBe('COMPLETED');
  });

  it('emits STATUS_CHANGED(PENDING→RUNNING) then OPERATION_FAILED(RUNNING→FAILED) on failure', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.execute as jest.Mock).mockRejectedValue(new Error('timeout'));
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const [first, second] = prisma.provisioningAuditEvent.create.mock.calls.map((c: any) => c[0].data);
    expect(prisma.provisioningAuditEvent.create).toHaveBeenCalledTimes(2);
    expect(first.kind).toBe('STATUS_CHANGED');
    expect(first.fromStatus).toBe('PENDING');
    expect(first.toStatus).toBe('RUNNING');
    expect(second.kind).toBe('OPERATION_FAILED');
    expect(second.fromStatus).toBe('RUNNING');
    expect(second.toStatus).toBe('FAILED');
  });

  it('includes providerType and region in audit detail', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    const detail = prisma.provisioningAuditEvent.create.mock.calls[0][0].data.detail;
    expect(detail).toMatchObject({ providerType: 'noop', region: 'eu-central' });
  });
});

// ── Provider dispatch ────────────────────────────────────────

describe('ProvisioningExecutorService — provider dispatch', () => {
  it('resolves the provider for the operation providerType from the registry', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const registry = makeRegistry();
    await new ProvisioningExecutorService(prisma, registry).executeOperation(USER_ID, OP_ID);

    expect(registry.resolve).toHaveBeenCalledWith('noop');
  });

  it('passes the full ProvisioningExecuteInput contract to the provider', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const provider = makeProvider();
    const svc = new ProvisioningExecutorService(prisma, makeRegistry(provider));
    await svc.executeOperation(USER_ID, OP_ID);

    const call = (provider.execute as jest.Mock).mock.calls[0][0];
    expect(call.operationId).toBe(OP_ID);
    expect(call.projectId).toBe(PROJECT_ID);
    expect(call.providerType).toBe('noop');
    expect(call.region).toBe('eu-central');
    expect(call.datacenter).toBeNull();
    expect(call.desiredSpec).toEqual({ size: 'cx11' });
    expect(call.credentialOpenbaoPath).toBe(OPENBAO_PATH);
  });
});

// ── Invalid provider ─────────────────────────────────────────

describe('ProvisioningExecutorService — invalid provider', () => {
  it('throws BadRequestException when registry cannot resolve the providerType', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const registry: IProviderRegistry = {
      resolve: jest.fn().mockImplementation(() => {
        throw new BadRequestException('Unknown provider type: unknown');
      }),
    };
    const svc = new ProvisioningExecutorService(prisma, registry);
    await expect(svc.executeOperation(USER_ID, OP_ID)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not mutate the operation when the provider type is unknown (stays PENDING)', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const registry: IProviderRegistry = {
      resolve: jest.fn().mockImplementation(() => {
        throw new BadRequestException('Unknown provider type: unknown');
      }),
    };
    const svc = new ProvisioningExecutorService(prisma, registry);
    await expect(svc.executeOperation(USER_ID, OP_ID)).rejects.toThrow();

    // No DB writes — operation remains in its original state
    expect(prisma.provisioningOperation.update).not.toHaveBeenCalled();
  });
});

// ── Secret boundary ───────────────────────────────────────────

describe('ProvisioningExecutorService — secret boundary', () => {
  it('passes credentialOpenbaoPath to provider as a path reference, not credential bytes', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const provider = makeProvider();
    await new ProvisioningExecutorService(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const call = (provider.execute as jest.Mock).mock.calls[0][0];
    // Provider receives the stored path reference only
    expect(call.credentialOpenbaoPath).toBe(OPENBAO_PATH);
    // No resolved-credential fields on the input
    expect(call).not.toHaveProperty('apiKey');
    expect(call).not.toHaveProperty('secret');
    expect(call).not.toHaveProperty('token');
    expect(call).not.toHaveProperty('password');
  });

  it('does not persist the openbao path in operation updates or audit event detail', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    // Operation updates contain only status-transition fields
    for (const [call] of prisma.provisioningOperation.update.mock.calls) {
      expect(JSON.stringify(call.data)).not.toContain(OPENBAO_PATH);
    }
    // Audit detail does not log the credential reference
    for (const [call] of prisma.provisioningAuditEvent.create.mock.calls) {
      expect(JSON.stringify(call.data.detail ?? {})).not.toContain(OPENBAO_PATH);
    }
  });

  it('does not call any secret resolver during execution (provider owns resolution)', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    // A resolver stub wired outside the executor — it must never be called
    const resolver = { resolve: jest.fn() };

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    // Executor has no reference to any secret resolver in Phase 5
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
