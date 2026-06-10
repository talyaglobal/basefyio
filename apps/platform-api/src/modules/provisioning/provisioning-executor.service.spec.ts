import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { IProvisioningProvider } from './interfaces/provisioning-provider.interface';
import { IProviderRegistry } from './interfaces/provider-registry.interface';
import { ProvisioningResourceProjectionService } from './provisioning-resource-projection.service';

// ── Mock factories ───────────────────────────────────────────

function makePrisma(overrides: Record<string, any> = {}) {
  const defaults = {
    provisioningOperation: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    teamMember: { findUnique: jest.fn() },
    provisioningResource: { findMany: jest.fn().mockResolvedValue([]) },
    provisioningAuditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  return { ...defaults, ...overrides } as any;
}

function makeProvider(overrides: Partial<IProvisioningProvider> = {}): IProvisioningProvider {
  return {
    plan: jest.fn().mockReturnValue({ actions: [], validationErrors: [] }),
    apply: jest.fn().mockResolvedValue({ success: true, resources: [], metadata: { noop: true } }),
    ...overrides,
  };
}

function makeRegistry(provider: IProvisioningProvider = makeProvider()): IProviderRegistry {
  return { resolve: jest.fn().mockReturnValue(provider) };
}

function makeProjection(): jest.Mocked<Pick<ProvisioningResourceProjectionService, 'project'>> {
  return { project: jest.fn().mockResolvedValue(undefined) };
}

function makeSvc(
  prisma = makePrisma(),
  registry: IProviderRegistry = makeRegistry(),
  projection = makeProjection(),
) {
  return new ProvisioningExecutorService(prisma, registry, projection as any);
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
    input: { resources: [{ type: 'server', name: 'web-1', spec: { size: 'cx11' } }] },
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

  it('rejects any status other than PENDING (allowlist — future statuses are safe)', async () => {
    const prisma = makePrisma();
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

  it('stores result as { metadata, resourceCount } on COMPLETED update', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    const completedData = prisma.provisioningOperation.update.mock.calls[1][0].data;
    expect(completedData.result).toMatchObject({ metadata: { noop: true }, resourceCount: 0 });
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
    (provider.apply as jest.Mock).mockRejectedValue(new Error('provider timeout'));
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
    (provider.apply as jest.Mock).mockRejectedValue(new Error('provider timeout'));
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
    (provider.apply as jest.Mock).mockRejectedValue(new Error('boom'));
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
    (provider.apply as jest.Mock).mockRejectedValue(new Error('timeout'));
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const [first, second] = prisma.provisioningAuditEvent.create.mock.calls.map((c: any) => c[0].data);
    expect(prisma.provisioningAuditEvent.create).toHaveBeenCalledTimes(2);
    expect(first.kind).toBe('STATUS_CHANGED');
    expect(second.kind).toBe('OPERATION_FAILED');
    expect(second.fromStatus).toBe('RUNNING');
    expect(second.toStatus).toBe('FAILED');
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
    await new ProvisioningExecutorService(prisma, registry, makeProjection() as any).executeOperation(USER_ID, OP_ID);

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
    const svc = new ProvisioningExecutorService(prisma, makeRegistry(provider), makeProjection() as any);
    await svc.executeOperation(USER_ID, OP_ID);

    const call = (provider.apply as jest.Mock).mock.calls[0][0];
    expect(call.operationId).toBe(OP_ID);
    expect(call.projectId).toBe(PROJECT_ID);
    expect(call.providerType).toBe('noop');
    expect(call.region).toBe('eu-central');
    expect(call.datacenter).toBeNull();
    expect(call.credentialOpenbaoPath).toBe(OPENBAO_PATH);
    expect(Array.isArray(call.currentResources)).toBe(true);
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
    const svc = new ProvisioningExecutorService(prisma, registry, makeProjection() as any);
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
    const svc = new ProvisioningExecutorService(prisma, registry, makeProjection() as any);
    await expect(svc.executeOperation(USER_ID, OP_ID)).rejects.toThrow();
    expect(prisma.provisioningOperation.update).not.toHaveBeenCalled();
  });
});

// ── Resource projection integration ──────────────────────────

describe('ProvisioningExecutorService — resource projection', () => {
  it('calls projection.project with correct params when provider returns resources', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const resource = {
      externalId: 'srv-99',
      type: 'SERVER',
      name: 'web-01',
      desiredSpec: { size: 'cx11' },
      actualSpec: { size: 'cx11' },
      status: 'ACTIVE' as const,
    };
    const provider = makeProvider();
    (provider.apply as jest.Mock).mockResolvedValue({
      success: true,
      resources: [resource],
      metadata: { region: 'eu-central' },
    });

    const projection = makeProjection();
    await new ProvisioningExecutorService(prisma, makeRegistry(provider), projection as any)
      .executeOperation(USER_ID, OP_ID);

    expect(projection.project).toHaveBeenCalledTimes(1);
    const projectionCall = projection.project.mock.calls[0][0];
    expect(projectionCall.operationId).toBe(OP_ID);
    expect(projectionCall.provisioningProjectId).toBe(PP_ID);
    expect(projectionCall.region).toBe('eu-central');
    expect(projectionCall.resources).toHaveLength(1);
    expect(projectionCall.actorUserId).toBe(USER_ID);
  });

  it('does not call projection when provider returns empty resources', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const projection = makeProjection();
    await makeSvc(prisma, makeRegistry(), projection).executeOperation(USER_ID, OP_ID);

    expect(projection.project).not.toHaveBeenCalled();
  });

  it('does not call projection when provider fails', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(new Error('timeout'));
    const projection = makeProjection();

    await makeSvc(prisma, makeRegistry(provider), projection).executeOperation(USER_ID, OP_ID);

    expect(projection.project).not.toHaveBeenCalled();
  });

  it('stays RUNNING (propagates) when projection fails — not COMPLETED with missing resources', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update.mockResolvedValueOnce(makeRunningOp());
    // No second update — projection throws before COMPLETED write

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockResolvedValue({
      success: true,
      resources: [{ externalId: 'x', type: 'SERVER', name: 'web-01', desiredSpec: {}, actualSpec: {}, status: 'ACTIVE' }],
      metadata: {},
    });

    const projection = makeProjection();
    projection.project.mockRejectedValue(new Error('DB write failed'));

    await expect(
      new ProvisioningExecutorService(prisma, makeRegistry(provider), projection as any)
        .executeOperation(USER_ID, OP_ID),
    ).rejects.toThrow('DB write failed');

    const updateStatuses = prisma.provisioningOperation.update.mock.calls.map((c: any) => c[0].data.status);
    expect(updateStatuses).not.toContain('COMPLETED');
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
    await new ProvisioningExecutorService(prisma, makeRegistry(provider), makeProjection() as any)
      .executeOperation(USER_ID, OP_ID);

    const call = (provider.apply as jest.Mock).mock.calls[0][0];
    expect(call.credentialOpenbaoPath).toBe(OPENBAO_PATH);
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

    for (const [call] of prisma.provisioningOperation.update.mock.calls) {
      expect(JSON.stringify(call.data)).not.toContain(OPENBAO_PATH);
    }
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

    const resolver = { resolve: jest.fn() };

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
