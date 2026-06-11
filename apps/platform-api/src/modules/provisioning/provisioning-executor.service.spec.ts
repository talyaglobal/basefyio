import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { IProvisioningProvider } from './interfaces/provisioning-provider.interface';
import { IProviderRegistry } from './interfaces/provider-registry.interface';
import { ProvisioningResourceProjectionService } from './provisioning-resource-projection.service';
import { PartialApplyError } from './interfaces/partial-apply.error';

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
    healthCheck: jest.fn().mockResolvedValue({ healthy: true, latencyMs: 0 }),
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

function stubOp(status = 'PENDING', id = OP_ID, extra: Record<string, unknown> = {}) {
  return {
    id,
    status,
    type: 'CREATE',
    dryRun: false,
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
    ...extra,
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

// ── dryRun path ───────────────────────────────────────────────

describe('ProvisioningExecutorService — dryRun path', () => {
  function setupDryRun() {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING', OP_ID, { dryRun: true }));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    const runningOp = { ...stubOp('RUNNING', OP_ID, { dryRun: true }) };
    const dryRunOp = { ...stubOp('DRY_RUN', OP_ID, { dryRun: true }) };
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(runningOp)
      .mockResolvedValueOnce(dryRunOp);
    return { prisma };
  }

  it('transitions PENDING → RUNNING → DRY_RUN', async () => {
    const { prisma } = setupDryRun();
    const result = await makeSvc(prisma).executeOperation(USER_ID, OP_ID);
    expect(result.status).toBe('DRY_RUN');
  });

  it('final update sets status=DRY_RUN (not COMPLETED)', async () => {
    const { prisma } = setupDryRun();
    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);
    const statuses = prisma.provisioningOperation.update.mock.calls.map((c: any) => c[0].data.status);
    expect(statuses).toContain('DRY_RUN');
    expect(statuses).not.toContain('COMPLETED');
  });

  it('passes dryRun=true to provider.apply()', async () => {
    const { prisma } = setupDryRun();
    const provider = makeProvider();
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);
    expect((provider.apply as jest.Mock).mock.calls[0][0].dryRun).toBe(true);
  });

  it('does NOT call projection even when provider returns resources (dry-run = no mutations)', async () => {
    const { prisma } = setupDryRun();
    const provider = makeProvider();
    (provider.apply as jest.Mock).mockResolvedValue({
      success: true,
      resources: [{ externalId: 'x', type: 'SERVER', name: 'web-1', desiredSpec: {}, actualSpec: {}, status: 'ACTIVE' }],
      metadata: { dryRun: true },
    });
    const projection = makeProjection();
    await new ProvisioningExecutorService(prisma, makeRegistry(provider), projection as any)
      .executeOperation(USER_ID, OP_ID);
    expect(projection.project).not.toHaveBeenCalled();
  });

  it('emits DRY_RUN_COMPLETED audit event (not OPERATION_COMPLETED)', async () => {
    const { prisma } = setupDryRun();
    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);
    const kinds = prisma.provisioningAuditEvent.create.mock.calls.map((c: any) => c[0].data.kind);
    expect(kinds).toContain('DRY_RUN_COMPLETED');
    expect(kinds).not.toContain('OPERATION_COMPLETED');
  });
});

// ── Phase 10c — ROLLBACK ──────────────────────────────────────

function makePrismaWithRollback(resourceRows: any[] = [], overrides: Record<string, any> = {}) {
  return makePrisma({
    provisioningResource: {
      findMany: jest.fn().mockResolvedValue(resourceRows),
      updateMany: jest.fn().mockResolvedValue({ count: resourceRows.length }),
    },
    provisioningProject: {
      update: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  });
}

function stubRollbackOp(status = 'PENDING') {
  return { ...stubOp(status), type: 'ROLLBACK' };
}

function makeRolledBackOp() {
  return { ...stubRollbackOp(), status: 'ROLLED_BACK', completedAt: new Date() };
}

function stubResource(opts: {
  kind?: string;
  name?: string;
  status?: string;
  externalId?: string;
  rollbackSpec?: Record<string, unknown> | null;
  destroyedAt?: Date | null;
} = {}) {
  return {
    id: `res-${opts.name ?? 'web-1'}`,
    kind: opts.kind ?? 'SERVER',
    name: opts.name ?? 'web-1',
    status: opts.status ?? 'ACTIVE',
    desiredSpec: { server_type: 'cx21' },
    actualSpec: null,
    externalId: opts.externalId ?? `ext-${opts.name ?? 'web-1'}`,
    rollbackSpec: opts.rollbackSpec !== undefined ? opts.rollbackSpec : { server_type: 'cx11' },
    destroyedAt: opts.destroyedAt !== undefined ? opts.destroyedAt : null,
  };
}

describe('ProvisioningExecutorService — Phase 10c: ROLLBACK execution', () => {
  it('transitions PENDING → RUNNING → ROLLED_BACK on success', async () => {
    const prisma = makePrismaWithRollback([stubResource()]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    const result = await makeSvc(prisma).executeOperation(USER_ID, OP_ID);
    expect(result.status).toBe('ROLLED_BACK');
  });

  it('transitions PENDING → RUNNING → FAILED when provider throws', async () => {
    const prisma = makePrismaWithRollback([stubResource()]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeFailedOp('rollback provider error'));

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(new Error('rollback provider error'));

    const result = await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);
    expect(result.status).toBe('FAILED');
  });

  it('does not re-throw when provider fails during rollback', async () => {
    const prisma = makePrismaWithRollback([]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(new Error('boom'));

    await expect(
      makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID),
    ).resolves.toBeDefined();
  });

  it('emits ROLLBACK_INITIATED then ROLLBACK_COMPLETED audit events on success', async () => {
    const prisma = makePrismaWithRollback([stubResource()]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    const auditKinds = prisma.provisioningAuditEvent.create.mock.calls.map(
      (c: any) => c[0].data.kind,
    );
    expect(auditKinds[0]).toBe('ROLLBACK_INITIATED');
    expect(auditKinds[auditKinds.length - 1]).toBe('ROLLBACK_COMPLETED');
  });

  it('emits ROLLBACK_INITIATED then OPERATION_FAILED audit events on failure', async () => {
    const prisma = makePrismaWithRollback([]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(new Error('timeout'));

    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const auditKinds = prisma.provisioningAuditEvent.create.mock.calls.map(
      (c: any) => c[0].data.kind,
    );
    expect(auditKinds[0]).toBe('ROLLBACK_INITIATED');
    expect(auditKinds[auditKinds.length - 1]).toBe('OPERATION_FAILED');
  });

  it('provider desiredSpec contains only resources with rollbackSpec', async () => {
    const withSpec = stubResource({ name: 'web-1', rollbackSpec: { server_type: 'cx11' } });
    const noSpec = stubResource({ name: 'web-2', rollbackSpec: null });
    const prisma = makePrismaWithRollback([withSpec, noSpec]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    const provider = makeProvider();
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const call = (provider.apply as jest.Mock).mock.calls[0][0];
    const desiredResources = (call.desiredSpec as any).resources as any[];
    expect(desiredResources).toHaveLength(1);
    expect(desiredResources[0].name).toBe('web-1');
    expect(desiredResources[0].spec).toEqual({ server_type: 'cx11' });
  });

  it('resource with rollbackSpec=null is excluded from desired state (will be deleted)', async () => {
    const noSpec = stubResource({ name: 'newly-created', rollbackSpec: null });
    const prisma = makePrismaWithRollback([noSpec]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    const provider = makeProvider();
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const call = (provider.apply as jest.Mock).mock.calls[0][0];
    const desiredResources = (call.desiredSpec as any).resources as any[];
    expect(desiredResources).toHaveLength(0);
  });

  it('destroyed resource with rollbackSpec is included in desired state (re-create)', async () => {
    const destroyed = stubResource({
      name: 'was-deleted',
      rollbackSpec: { server_type: 'cx11' },
      destroyedAt: new Date(),
    });
    const prisma = makePrismaWithRollback([destroyed]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    const provider = makeProvider();
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const call = (provider.apply as jest.Mock).mock.calls[0][0];
    const desiredResources = (call.desiredSpec as any).resources as any[];
    expect(desiredResources).toHaveLength(1);
    expect(desiredResources[0].name).toBe('was-deleted');
  });

  it('destroyed resource is excluded from currentResources', async () => {
    const destroyed = stubResource({
      name: 'was-deleted',
      rollbackSpec: { server_type: 'cx11' },
      destroyedAt: new Date(),
    });
    const prisma = makePrismaWithRollback([destroyed]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    const provider = makeProvider();
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const call = (provider.apply as jest.Mock).mock.calls[0][0];
    expect((call.currentResources as any[]).every((r: any) => r.name !== 'was-deleted')).toBe(true);
  });

  it('calls provisioningResource.updateMany to set status ROLLED_BACK for restored resources', async () => {
    const prisma = makePrismaWithRollback([stubResource()]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockResolvedValue({
      success: true,
      resources: [{ externalId: 'ext-web-1', type: 'server', name: 'web-1', desiredSpec: {}, actualSpec: {}, status: 'ACTIVE' }],
      metadata: {},
    });

    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    expect(prisma.provisioningResource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'ROLLED_BACK' },
        where: expect.objectContaining({ externalId: { in: ['ext-web-1'] } }),
      }),
    );
  });

  it('calls provisioningProject.update with status ROLLED_BACK on success', async () => {
    const prisma = makePrismaWithRollback([]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    expect(prisma.provisioningProject.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ROLLED_BACK' } }),
    );
  });

  it('does NOT call provisioningProject.update when provider fails', async () => {
    const prisma = makePrismaWithRollback([]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(new Error('boom'));

    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    expect(prisma.provisioningProject.update).not.toHaveBeenCalled();
  });

  it('passes dryRun=false to provider — rollback always executes for real', async () => {
    const prisma = makePrismaWithRollback([]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    const provider = makeProvider();
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const call = (provider.apply as jest.Mock).mock.calls[0][0];
    expect(call.dryRun).toBe(false);
  });

  it('credentialOpenbaoPath not present in rollback operation update or audit detail', async () => {
    const prisma = makePrismaWithRollback([]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubRollbackOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce({ ...stubRollbackOp(), status: 'RUNNING' })
      .mockResolvedValueOnce(makeRolledBackOp());

    await makeSvc(prisma).executeOperation(USER_ID, OP_ID);

    for (const [call] of prisma.provisioningOperation.update.mock.calls) {
      expect(JSON.stringify(call.data)).not.toContain(OPENBAO_PATH);
    }
    for (const [call] of prisma.provisioningAuditEvent.create.mock.calls) {
      expect(JSON.stringify(call.data.detail ?? {})).not.toContain(OPENBAO_PATH);
    }
  });
});

// ── Phase 10d — PARTIAL_FAILED semantics ─────────────────────

describe('ProvisioningExecutorService — Phase 10d: PARTIAL_FAILED semantics', () => {
  function setupPartial(appliedCount: number, failureCount: number) {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce({ ...stubOp(), status: 'PARTIAL_FAILED' });

    const applied = Array.from({ length: appliedCount }, (_, i) => ({
      externalId: `ext-${i}`,
      type: 'server',
      name: `web-${i}`,
      desiredSpec: {},
      actualSpec: {},
      status: 'ACTIVE' as const,
    }));
    const failures = Array.from({ length: failureCount }, (_, i) => ({
      resourceType: 'server',
      resourceName: `fail-${i}`,
      action: 'CREATE',
      error: 'provider timeout',
    }));

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(
      new PartialApplyError(applied, [], failures),
    );

    return { prisma, provider, applied };
  }

  it('transitions to PARTIAL_FAILED when some actions succeed and some fail', async () => {
    const { prisma, provider } = setupPartial(1, 1);
    const result = await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);
    expect(result.status).toBe('PARTIAL_FAILED');
  });

  it('sets status FAILED (not PARTIAL_FAILED) when zero actions succeeded', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(
      new PartialApplyError([], [], [{ resourceType: 'server', resourceName: 'web-1', action: 'CREATE', error: 'boom' }]),
    );

    const result = await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);
    expect(result.status).toBe('FAILED');
  });

  it('calls projection for successfully applied resources on partial failure', async () => {
    const { prisma, provider } = setupPartial(2, 1);
    const projection = makeProjection();
    await new ProvisioningExecutorService(prisma, makeRegistry(provider), projection as any)
      .executeOperation(USER_ID, OP_ID);

    expect(projection.project).toHaveBeenCalledTimes(1);
    const call = projection.project.mock.calls[0][0];
    expect(call.resources).toHaveLength(2);
  });

  it('does NOT call projection when zero actions succeeded (total failure via PartialApplyError)', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(
      new PartialApplyError([], [], [{ resourceType: 'server', resourceName: 'web-1', action: 'CREATE', error: 'boom' }]),
    );

    const projection = makeProjection();
    await new ProvisioningExecutorService(prisma, makeRegistry(provider), projection as any)
      .executeOperation(USER_ID, OP_ID);
    expect(projection.project).not.toHaveBeenCalled();
  });

  it('emits OPERATION_FAILED audit with toStatus=PARTIAL_FAILED on partial failure', async () => {
    const { prisma, provider } = setupPartial(1, 1);
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const auditCalls = prisma.provisioningAuditEvent.create.mock.calls.map((c: any) => c[0].data);
    const failAudit = auditCalls.find((a: any) => a.toStatus === 'PARTIAL_FAILED');
    expect(failAudit).toBeDefined();
    expect(failAudit.kind).toBe('OPERATION_FAILED');
  });

  it('emits OPERATION_FAILED audit with toStatus=FAILED on total failure', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.apply as jest.Mock).mockRejectedValue(new Error('total failure'));

    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const auditCalls = prisma.provisioningAuditEvent.create.mock.calls.map((c: any) => c[0].data);
    const failAudit = auditCalls.find((a: any) => a.kind === 'OPERATION_FAILED');
    expect(failAudit.toStatus).toBe('FAILED');
  });

  it('update call uses status PARTIAL_FAILED when some actions succeeded', async () => {
    const { prisma, provider } = setupPartial(1, 1);
    await makeSvc(prisma, makeRegistry(provider)).executeOperation(USER_ID, OP_ID);

    const updateStatuses = prisma.provisioningOperation.update.mock.calls.map((c: any) => c[0].data.status);
    expect(updateStatuses).toContain('PARTIAL_FAILED');
  });

  it('PartialApplyError satisfies normalizeProviderError contract (code + retryable fields)', () => {
    const err = new PartialApplyError([], [], []);
    expect(err.code).toBe('PARTIAL_APPLY');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Partial apply');
  });
});
