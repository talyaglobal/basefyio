import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { OperationTypeDto } from './dto/create-provisioning-operation.dto';

// ── Prisma mock factory ──────────────────────────────────────
//
// $transaction receives the merged mock as `tx` so assertions on
// provisioningOperation.create / provisioningAuditEvent.create still work.

function makePrisma(overrides: Record<string, any> = {}) {
  const defaults: Record<string, any> = {
    project: { findUnique: jest.fn() },
    teamMember: { findUnique: jest.fn() },
    provisioningProject: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    provisioningCredentialRef: { findUnique: jest.fn() },
    provisioningOperation: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    provisioningResource: { findMany: jest.fn(), findUnique: jest.fn() },
    provisioningAuditEvent: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const merged = { ...defaults, ...overrides };
  merged.$transaction = jest.fn().mockImplementation((cb: any) => cb(merged));
  return merged as any;
}

function makeRegistry() {
  return {
    list: jest.fn().mockReturnValue([
      { name: 'hetzner', displayName: 'Hetzner Cloud', regions: [], resourceTypes: [], supportedResources: [], supportsCreate: true, supportsUpdate: true, supportsRollback: true, supportsDryRun: true },
      { name: 'docker',  displayName: 'Docker',        regions: [], resourceTypes: [], supportedResources: [], supportsCreate: true, supportsUpdate: true, supportsRollback: false, supportsDryRun: true },
    ]),
    resolve: jest.fn(),
  } as any;
}

const TEAM_ID = 'team-1';
const PROJECT_ID = 'project-1';
const PP_ID = 'pp-1';
const CRED_ID = 'cred-1';
const USER_ID = 'user-1';
const IDEM_KEY = 'key-abc123';

function memberOf(teamId = TEAM_ID) {
  return { teamId, userId: USER_ID };
}

function stubProject(teamId = TEAM_ID) {
  return { teamId };
}

function stubCredRef(teamId = TEAM_ID) {
  return { teamId, revokedAt: null };
}

function stubProvisioningProject(id = PP_ID) {
  return { id, project: { teamId: TEAM_ID } };
}

// Shared base DTOs
const BASE_CREATE_PROJECT_DTO = {
  projectId: PROJECT_ID,
  credentialRefId: CRED_ID,
  region: 'eu-central',
  desiredSpec: { serverType: 'cx21' },
  dryRun: false,
  idempotencyKey: IDEM_KEY,
};

const BASE_CREATE_OPERATION_DTO = {
  projectId: PROJECT_ID,
  type: OperationTypeDto.CREATE,
  idempotencyKey: IDEM_KEY,
  desiredSpec: { serverType: 'cx21', name: 'api-prod-01' },
  dryRun: false,
};

// ── Helpers to set up createOperation ownership mocks ────────
//
// createOperation resolves: project.findUnique → teamMember.findUnique →
// provisioningProject.findUnique(by projectId).

function setupOperationOwnership(
  prisma: any,
  { teamId = TEAM_ID, ppExists = true } = {},
) {
  prisma.project.findUnique.mockResolvedValue(stubProject(teamId));
  prisma.teamMember.findUnique.mockResolvedValue(memberOf(teamId));
  prisma.provisioningProject.findUnique.mockResolvedValue(
    ppExists ? { id: PP_ID } : null,
  );
}

// ── createOperation — ownership ──────────────────────────────

describe('ProvisioningService.createOperation — ownership', () => {
  it('throws NotFoundException when platform project does not exist', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createOperation(USER_ID, { ...BASE_CREATE_OPERATION_DTO, projectId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException when user is not a team member', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createOperation(USER_ID, BASE_CREATE_OPERATION_DTO),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFoundException when no provisioning project exists for this project', async () => {
    const prisma = makePrisma();
    setupOperationOwnership(prisma, { ppExists: false });

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createOperation(USER_ID, BASE_CREATE_OPERATION_DTO),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── createOperation — idempotency ────────────────────────────

describe('ProvisioningService.createOperation — idempotency', () => {
  it('returns existing operation with idempotent=true on compatible replay', async () => {
    const existingOp = {
      id: 'op-existing',
      provisioningProjectId: PP_ID,
      type: 'CREATE',
      status: 'PENDING',
      dryRun: false,
      idempotencyKey: IDEM_KEY,
      createdAt: new Date(),
    };
    const prisma = makePrisma();
    setupOperationOwnership(prisma);
    prisma.provisioningOperation.findUnique.mockResolvedValue(existingOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.createOperation(USER_ID, BASE_CREATE_OPERATION_DTO);

    expect(result.idempotent).toBe(true);
    expect(result.provisioningOperationId).toBe('op-existing');
    expect(prisma.provisioningOperation.create).not.toHaveBeenCalled();
    expect(prisma.provisioningAuditEvent.create).not.toHaveBeenCalled();
  });

  it('throws ConflictException when same key has incompatible type', async () => {
    const existingOp = {
      id: 'op-existing',
      provisioningProjectId: PP_ID,
      type: 'DELETE',   // different from requested CREATE
      status: 'PENDING',
      dryRun: false,
      idempotencyKey: IDEM_KEY,
      createdAt: new Date(),
    };
    const prisma = makePrisma();
    setupOperationOwnership(prisma);
    prisma.provisioningOperation.findUnique.mockResolvedValue(existingOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createOperation(USER_ID, BASE_CREATE_OPERATION_DTO),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws ConflictException when same key has incompatible dryRun value', async () => {
    const existingOp = {
      id: 'op-existing',
      provisioningProjectId: PP_ID,
      type: 'CREATE',
      status: 'DRY_RUN',
      dryRun: true,     // different from requested false
      idempotencyKey: IDEM_KEY,
      createdAt: new Date(),
    };
    const prisma = makePrisma();
    setupOperationOwnership(prisma);
    prisma.provisioningOperation.findUnique.mockResolvedValue(existingOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createOperation(USER_ID, BASE_CREATE_OPERATION_DTO),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a new operation when key is different — never 409', async () => {
    const newOp = {
      id: 'op-new',
      provisioningProjectId: PP_ID,
      type: 'CREATE',
      status: 'PENDING',
      dryRun: false,
      idempotencyKey: 'different-key',
      createdAt: new Date(),
    };
    const prisma = makePrisma();
    setupOperationOwnership(prisma);
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);
    prisma.provisioningOperation.create.mockResolvedValue(newOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.createOperation(USER_ID, {
      ...BASE_CREATE_OPERATION_DTO,
      idempotencyKey: 'different-key',
    });

    expect(result.idempotent).toBe(false);
    expect(prisma.provisioningOperation.create).toHaveBeenCalledTimes(1);
  });
});

// ── createOperation — dryRun ─────────────────────────────────

describe('ProvisioningService.createOperation — dryRun', () => {
  it('dryRun=true sets DRY_RUN status, completedAt, emits DRY_RUN_COMPLETED', async () => {
    const dryOp = {
      id: 'op-dry',
      provisioningProjectId: PP_ID,
      type: 'CREATE',
      status: 'DRY_RUN',
      dryRun: true,
      idempotencyKey: IDEM_KEY,
      createdAt: new Date(),
    };
    const prisma = makePrisma();
    setupOperationOwnership(prisma);
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);
    prisma.provisioningOperation.create.mockResolvedValue(dryOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.createOperation(USER_ID, {
      ...BASE_CREATE_OPERATION_DTO,
      dryRun: true,
    });

    const createCall = prisma.provisioningOperation.create.mock.calls[0][0];
    expect(createCall.data.status).toBe('DRY_RUN');
    expect(createCall.data.dryRun).toBe(true);
    expect(createCall.data.completedAt).toBeDefined();

    const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0];
    expect(auditCall.data.kind).toBe('DRY_RUN_COMPLETED');

    expect(result.status).toBe('DRY_RUN');
    expect(result.dryRun).toBe(true);
  });

  it('dryRun=false sets PENDING status, no completedAt, emits OPERATION_STARTED', async () => {
    const pendingOp = {
      id: 'op-pending',
      provisioningProjectId: PP_ID,
      type: 'CREATE',
      status: 'PENDING',
      dryRun: false,
      idempotencyKey: IDEM_KEY,
      createdAt: new Date(),
    };
    const prisma = makePrisma();
    setupOperationOwnership(prisma);
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);
    prisma.provisioningOperation.create.mockResolvedValue(pendingOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await svc.createOperation(USER_ID, BASE_CREATE_OPERATION_DTO);

    const createCall = prisma.provisioningOperation.create.mock.calls[0][0];
    expect(createCall.data.status).toBe('PENDING');
    expect(createCall.data.completedAt).toBeUndefined();

    const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0];
    expect(auditCall.data.kind).toBe('OPERATION_STARTED');
  });

  it('does not emit ROLLBACK_INITIATED at creation — only at execution phase', async () => {
    const rollbackOp = {
      id: 'op-rb',
      provisioningProjectId: PP_ID,
      type: 'ROLLBACK',
      status: 'PENDING',
      dryRun: false,
      idempotencyKey: 'rb-key',
      createdAt: new Date(),
    };
    const prisma = makePrisma();
    setupOperationOwnership(prisma);
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);
    prisma.provisioningOperation.create.mockResolvedValue(rollbackOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await svc.createOperation(USER_ID, {
      ...BASE_CREATE_OPERATION_DTO,
      type: OperationTypeDto.ROLLBACK,
      idempotencyKey: 'rb-key',
    });

    const auditKinds = prisma.provisioningAuditEvent.create.mock.calls.map(
      (c: any) => c[0].data.kind,
    );
    expect(auditKinds).not.toContain('ROLLBACK_INITIATED');
    expect(auditKinds).toContain('OPERATION_STARTED');
    expect(prisma.provisioningAuditEvent.create).toHaveBeenCalledTimes(1);
  });

  it('desiredSpec stored as input on the operation row', async () => {
    const spec = { serverType: 'cx31', name: 'worker-01', location: 'fsn1' };
    const newOp = {
      id: 'op-spec',
      provisioningProjectId: PP_ID,
      type: 'CREATE',
      status: 'PENDING',
      dryRun: false,
      idempotencyKey: IDEM_KEY,
      createdAt: new Date(),
    };
    const prisma = makePrisma();
    setupOperationOwnership(prisma);
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);
    prisma.provisioningOperation.create.mockResolvedValue(newOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await svc.createOperation(USER_ID, { ...BASE_CREATE_OPERATION_DTO, desiredSpec: spec });

    const createCall = prisma.provisioningOperation.create.mock.calls[0][0];
    expect(createCall.data.input).toEqual(spec);
  });
});

// ── listResources ─────────────────────────────────────────────

describe('ProvisioningService.listResources', () => {
  const now = new Date('2026-06-09T10:00:00.000Z');

  function stubResource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'res-1',
      kind: 'SERVER',
      name: 'api-prod-01',
      status: 'ACTIVE',
      externalId: '12345',
      desiredSpec: { serverType: 'cx21' },
      actualSpec: { ip: '1.2.3.4' },
      destroyedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it('throws NotFoundException when platform project does not exist', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.listResources(USER_ID, 'missing-project'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException (not 403) when user is not a team member', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.listResources('other-user', PROJECT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns empty array when no provisioning project exists', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.listResources(USER_ID, PROJECT_ID);

    expect(result).toEqual([]);
    expect(prisma.provisioningResource.findMany).not.toHaveBeenCalled();
  });

  it('excludes destroyed resources by default', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID });
    prisma.provisioningResource.findMany = jest.fn().mockResolvedValue([]);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await svc.listResources(USER_ID, PROJECT_ID);

    const where = prisma.provisioningResource.findMany.mock.calls[0][0].where;
    expect(where.destroyedAt).toBeNull();
  });

  it('includes destroyed resources when includeDestroyed=true', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID });
    prisma.provisioningResource.findMany = jest.fn().mockResolvedValue([]);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await svc.listResources(USER_ID, PROJECT_ID, true);

    const where = prisma.provisioningResource.findMany.mock.calls[0][0].where;
    expect(where.destroyedAt).toBeUndefined();
  });

  it('maps rows to GetResourceResponse with correct shape', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID });
    prisma.provisioningResource.findMany = jest.fn().mockResolvedValue([
      stubResource(),
    ]);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.listResources(USER_ID, PROJECT_ID);

    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item.id).toBe('res-1');
    expect(item.projectId).toBe(PROJECT_ID);
    expect(item.type).toBe('SERVER');       // kind → type
    expect(item.name).toBe('api-prod-01');
    expect(item.status).toBe('ACTIVE');
    expect(item.externalId).toBe('12345');
    expect(item.desiredSpec).toEqual({ serverType: 'cx21' });
    expect(item.actualSpec).toEqual({ ip: '1.2.3.4' });
    expect(item.createdAt).toBe(now.toISOString());
    expect(item.updatedAt).toBe(now.toISOString());
    // rollbackSpec must not appear in response
    expect(item).not.toHaveProperty('rollbackSpec');
  });

  it('maps actualSpec to null when missing', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID });
    prisma.provisioningResource.findMany = jest
      .fn()
      .mockResolvedValue([stubResource({ actualSpec: null })]);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const [item] = await svc.listResources(USER_ID, PROJECT_ID);

    expect(item.actualSpec).toBeNull();
  });

  it('does not write any audit events or transactions — pure read', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID });
    prisma.provisioningResource.findMany = jest.fn().mockResolvedValue([]);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await svc.listResources(USER_ID, PROJECT_ID);

    expect(prisma.provisioningAuditEvent.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ── getOperation ─────────────────────────────────────────────

describe('ProvisioningService.getOperation', () => {
  const now = new Date('2026-06-09T10:00:00.000Z');

  function stubFullOp(overrides: Record<string, unknown> = {}) {
    return {
      id: 'op-1',
      provisioningProjectId: PP_ID,
      type: 'CREATE',
      status: 'PENDING',
      dryRun: false,
      idempotencyKey: IDEM_KEY,
      requestedBy: USER_ID,
      input: { serverType: 'cx21' },
      result: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      provisioningProject: {
        projectId: PROJECT_ID,
        project: { teamId: TEAM_ID },
      },
      ...overrides,
    };
  }

  it('throws NotFoundException when operation does not exist', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.getOperation(USER_ID, 'missing-op'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException (not 403) when requester is not a team member', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubFullOp());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.getOperation('other-user', 'op-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns mapped response with correct shape', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubFullOp());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.getOperation(USER_ID, 'op-1');

    expect(result.id).toBe('op-1');
    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.type).toBe('CREATE');
    expect(result.status).toBe('PENDING');
    expect(result.dryRun).toBe(false);
    expect(result.idempotencyKey).toBe(IDEM_KEY);
    expect(result.input).toEqual({ serverType: 'cx21' });
    expect(result.result).toBeNull();
    expect(result.error).toBeNull();
    expect(result.createdAt).toBe(now.toISOString());
    expect(result.startedAt).toBeNull();
    expect(result.completedAt).toBeNull();
  });

  it('updatedAt falls back to startedAt when completedAt is null', async () => {
    const started = new Date('2026-06-09T10:05:00.000Z');
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(
      stubFullOp({ startedAt: started }),
    );
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.getOperation(USER_ID, 'op-1');

    expect(result.updatedAt).toBe(started.toISOString());
    expect(result.startedAt).toBe(started.toISOString());
  });

  it('updatedAt uses completedAt when present', async () => {
    const started = new Date('2026-06-09T10:05:00.000Z');
    const completed = new Date('2026-06-09T10:10:00.000Z');
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(
      stubFullOp({ startedAt: started, completedAt: completed }),
    );
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.getOperation(USER_ID, 'op-1');

    expect(result.updatedAt).toBe(completed.toISOString());
    expect(result.completedAt).toBe(completed.toISOString());
  });

  it('maps errorMessage to error.message when present', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(
      stubFullOp({ status: 'FAILED', errorMessage: 'provider timeout' }),
    );
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.getOperation(USER_ID, 'op-1');

    expect(result.error).toEqual({ message: 'provider timeout' });
    expect(result.status).toBe('FAILED');
  });

  it('maps result when operation succeeded', async () => {
    const resultPayload = { serverId: 12345, ip: '1.2.3.4' };
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(
      stubFullOp({ status: 'COMPLETED', result: resultPayload }),
    );
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.getOperation(USER_ID, 'op-1');

    expect(result.result).toEqual(resultPayload);
    expect(result.error).toBeNull();
  });

  it('does not write any audit events — read-only path', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubFullOp());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma, makeRegistry());
    await svc.getOperation(USER_ID, 'op-1');

    expect(prisma.provisioningAuditEvent.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ── createProject — ownership + credentialRef ─────────────────

describe('ProvisioningService.createProject', () => {
  it('throws NotFoundException when project does not exist', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createProject(USER_ID, { ...BASE_CREATE_PROJECT_DTO, projectId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException when user is not a team member', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createProject(USER_ID, BASE_CREATE_PROJECT_DTO),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws ForbiddenException when credentialRef belongs to a different team', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject('team-A'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf('team-A'));
    prisma.provisioningCredentialRef.findUnique.mockResolvedValue(stubCredRef('team-B'));

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createProject(USER_ID, BASE_CREATE_PROJECT_DTO),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws ConflictException when credentialRef is revoked', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningCredentialRef.findUnique.mockResolvedValue({
      teamId: TEAM_ID,
      revokedAt: new Date(),
    });

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createProject(USER_ID, BASE_CREATE_PROJECT_DTO),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws ConflictException when project exists and idempotency key does not match', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningCredentialRef.findUnique.mockResolvedValue(stubCredRef());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID });
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.createProject(USER_ID, BASE_CREATE_PROJECT_DTO),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns idempotent response when project and operation already exist with same key', async () => {
    const existingPP = { id: PP_ID, provider: 'hetzner', status: 'PENDING' };
    const existingOp = { id: 'op-1', status: 'PENDING', dryRun: false };
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningCredentialRef.findUnique.mockResolvedValue(stubCredRef());
    prisma.provisioningProject.findUnique.mockResolvedValue(existingPP);
    prisma.provisioningOperation.findUnique.mockResolvedValue(existingOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.createProject(USER_ID, BASE_CREATE_PROJECT_DTO);

    expect(result.operation.idempotent).toBe(true);
    expect(result.provisioningProjectId).toBe(PP_ID);
    expect(prisma.provisioningProject.create).not.toHaveBeenCalled();
    expect(prisma.provisioningAuditEvent.create).not.toHaveBeenCalled();
  });

  it('creates project + operation atomically and returns mapped response', async () => {
    const createdPP = { id: PP_ID, provider: 'hetzner', status: 'PENDING' };
    const createdOp = { id: 'op-new', status: 'PENDING', dryRun: false };
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningCredentialRef.findUnique.mockResolvedValue(stubCredRef());
    prisma.provisioningProject.findUnique.mockResolvedValue(null);
    prisma.provisioningProject.create.mockResolvedValue(createdPP);
    prisma.provisioningOperation.create.mockResolvedValue(createdOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.createProject(USER_ID, BASE_CREATE_PROJECT_DTO);

    expect(result.provisioningProjectId).toBe(PP_ID);
    expect(result.provider).toBe('hetzner');
    expect(result.status).toBe('PENDING');
    expect(result.operation.provisioningOperationId).toBe('op-new');
    expect(result.operation.idempotent).toBe(false);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.provisioningProject.create).toHaveBeenCalledTimes(1);
    expect(prisma.provisioningOperation.create).toHaveBeenCalledTimes(1);

    const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0];
    expect(auditCall.data.kind).toBe('STATUS_CHANGED');
    expect(auditCall.data.fromStatus).toBeUndefined();
    expect(auditCall.data.toStatus).toBe('PENDING');
  });

  it('sets operation to DRY_RUN and emits DRY_RUN_COMPLETED when dryRun=true', async () => {
    const createdPP = { id: PP_ID, provider: 'hetzner', status: 'PENDING' };
    const createdOp = { id: 'op-dry', status: 'DRY_RUN', dryRun: true };
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningCredentialRef.findUnique.mockResolvedValue(stubCredRef());
    prisma.provisioningProject.findUnique.mockResolvedValue(null);
    prisma.provisioningProject.create.mockResolvedValue(createdPP);
    prisma.provisioningOperation.create.mockResolvedValue(createdOp);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.createProject(USER_ID, {
      ...BASE_CREATE_PROJECT_DTO,
      dryRun: true,
    });

    const opCreateCall = prisma.provisioningOperation.create.mock.calls[0][0];
    expect(opCreateCall.data.status).toBe('DRY_RUN');
    expect(opCreateCall.data.completedAt).toBeDefined();

    const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0];
    expect(auditCall.data.kind).toBe('DRY_RUN_COMPLETED');

    expect(result.operation.dryRun).toBe(true);
  });
});

// ── listOperationEvents — pagination ─────────────────────────

const OP_ID = 'op-events-1';

function makeOp() {
  return {
    id: OP_ID,
    provisioningProject: { project: { teamId: TEAM_ID } },
  };
}

function makeEventRow(seq: number, createdAt?: Date): any {
  const ts = createdAt ?? new Date(Date.UTC(2026, 5, 11, 0, 0, seq));
  return {
    id: `evt-${seq.toString().padStart(3, '0')}`,
    operationId: OP_ID,
    kind: 'STATUS_CHANGED',
    actorUserId: USER_ID,
    fromStatus: null,
    toStatus: 'RUNNING',
    detail: null,
    createdAt: ts,
  };
}

function makeEventSvc(prisma: any) {
  return new ProvisioningService(prisma, makeRegistry());
}

describe('ProvisioningService.listOperationEvents', () => {
  function basePrisma(rows: any[]) {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(makeOp());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningAuditEvent.findMany.mockResolvedValue(rows);
    return prisma;
  }

  it('returns { events, nextCursor: null } when rows ≤ default limit', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeEventRow(i + 1));
    const svc = makeEventSvc(basePrisma(rows));
    const result = await svc.listOperationEvents(USER_ID, OP_ID);
    expect(result.events).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  it('default order is createdAt ASC (orderBy passed to findMany)', async () => {
    const svc = makeEventSvc(basePrisma([]));
    await svc.listOperationEvents(USER_ID, OP_ID);
    const call = basePrisma([]).provisioningAuditEvent.findMany.mock?.calls;
    // Verify directly on the mock we control
    const prisma = basePrisma([]);
    prisma.provisioningAuditEvent.findMany.mockResolvedValue([]);
    const svc2 = makeEventSvc(prisma);
    await svc2.listOperationEvents(USER_ID, OP_ID);
    const orderBy = prisma.provisioningAuditEvent.findMany.mock.calls[0][0].orderBy;
    expect(orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('nextCursor is returned when rows exceed limit', async () => {
    // Default limit is 50; return 51 rows
    const rows = Array.from({ length: 51 }, (_, i) => makeEventRow(i + 1));
    const prisma = basePrisma(rows);
    const svc = makeEventSvc(prisma);
    const result = await svc.listOperationEvents(USER_ID, OP_ID);
    expect(result.events).toHaveLength(50);
    expect(result.nextCursor).not.toBeNull();
    expect(typeof result.nextCursor).toBe('string');
  });

  it('respects custom limit', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => makeEventRow(i + 1));
    const prisma = basePrisma(rows);
    const svc = makeEventSvc(prisma);
    const result = await svc.listOperationEvents(USER_ID, OP_ID, { limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.nextCursor).not.toBeNull();
  });

  it('nextCursor is null when exactly limit rows returned', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeEventRow(i + 1));
    const prisma = basePrisma(rows);
    const svc = makeEventSvc(prisma);
    const result = await svc.listOperationEvents(USER_ID, OP_ID, { limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });

  it('cursor filter is applied to findMany where clause', async () => {
    const anchor = makeEventRow(3);
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: anchor.createdAt.toISOString(), id: anchor.id }),
    ).toString('base64url');

    const prisma = basePrisma([]);
    const svc = makeEventSvc(prisma);
    await svc.listOperationEvents(USER_ID, OP_ID, { cursor });

    const where = prisma.provisioningAuditEvent.findMany.mock.calls[0][0].where;
    expect(where).toHaveProperty('OR');
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it('invalid cursor throws 400 BadRequestException', async () => {
    const svc = makeEventSvc(basePrisma([]));
    await expect(
      svc.listOperationEvents(USER_ID, OP_ID, { cursor: 'not-valid-base64url!!!' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('truncated JSON cursor throws 400', async () => {
    const bad = Buffer.from('{createdAt:').toString('base64url');
    const svc = makeEventSvc(basePrisma([]));
    await expect(
      svc.listOperationEvents(USER_ID, OP_ID, { cursor: bad }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('cursor with missing id field throws 400', async () => {
    const bad = Buffer.from(JSON.stringify({ createdAt: '2026-01-01T00:00:00Z' })).toString('base64url');
    const svc = makeEventSvc(basePrisma([]));
    await expect(
      svc.listOperationEvents(USER_ID, OP_ID, { cursor: bad }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('returns 404 when operation not found', async () => {
    const prisma = basePrisma([]);
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);
    const svc = makeEventSvc(prisma);
    await expect(svc.listOperationEvents(USER_ID, OP_ID)).rejects.toMatchObject({ status: 404 });
  });

  it('returns 404 when user is not a team member', async () => {
    const prisma = basePrisma([]);
    prisma.teamMember.findUnique.mockResolvedValue(null);
    const svc = makeEventSvc(prisma);
    await expect(svc.listOperationEvents(USER_ID, OP_ID)).rejects.toMatchObject({ status: 404 });
  });
});

// ── ProvisioningService.setProjectProvider ───────────────────

describe('ProvisioningService.setProjectProvider', () => {
  const PP_DB_ID = 'pp-db-id';
  const PROJECT_ID_LOCAL = 'proj-001';

  function makePPRow(provider = 'hetzner') {
    return {
      id: PP_DB_ID,
      projectId: PROJECT_ID_LOCAL,
      provider,
      project: { teamId: TEAM_ID },
    };
  }

  it('updates provider when valid provider is given', async () => {
    const prisma = makePrisma();
    (prisma.provisioningProject.findUnique as jest.Mock).mockResolvedValue(makePPRow());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    (prisma.provisioningProject.update as jest.Mock).mockResolvedValue({
      id: PP_DB_ID,
      projectId: PROJECT_ID_LOCAL,
      provider: 'docker',
    });
    const svc = new ProvisioningService(prisma as any, makeRegistry());
    const result = await svc.setProjectProvider(USER_ID, PROJECT_ID_LOCAL, { provider: 'docker' });
    expect(result.provider).toBe('docker');
    expect(result.projectId).toBe(PROJECT_ID_LOCAL);
  });

  it('throws 400 when provider is not registered', async () => {
    const prisma = makePrisma();
    (prisma.provisioningProject.findUnique as jest.Mock).mockResolvedValue(makePPRow());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    const svc = new ProvisioningService(prisma as any, makeRegistry());
    await expect(svc.setProjectProvider(USER_ID, PROJECT_ID_LOCAL, { provider: 'aws' })).rejects.toThrow(BadRequestException);
  });

  it('throws 404 when project not found', async () => {
    const prisma = makePrisma();
    (prisma.provisioningProject.findUnique as jest.Mock).mockResolvedValue(null);
    const svc = new ProvisioningService(prisma as any, makeRegistry());
    await expect(svc.setProjectProvider(USER_ID, 'no-such-proj', { provider: 'hetzner' })).rejects.toThrow(NotFoundException);
  });

  it('throws 404 when userId does not match project owner', async () => {
    const prisma = makePrisma();
    (prisma.provisioningProject.findUnique as jest.Mock).mockResolvedValue(makePPRow());
    prisma.teamMember.findUnique.mockResolvedValue(null); // not a member
    const svc = new ProvisioningService(prisma as any, makeRegistry());
    await expect(svc.setProjectProvider(USER_ID, PROJECT_ID_LOCAL, { provider: 'hetzner' })).rejects.toThrow(NotFoundException);
  });
});

// ── ProvisioningService.listProjectResources ──────────────────

describe('ProvisioningService.listProjectResources', () => {
  function stubResourceRow(seq: number) {
    return {
      id: `res-${seq.toString().padStart(3, '0')}`,
      kind: 'server',
      name: `web-${seq}`,
      status: 'ACTIVE',
      externalId: `ext-${seq}`,
      desiredSpec: { serverType: 'cx11' },
      actualSpec: { ip: `1.2.3.${seq}` },
      destroyedAt: null,
      createdAt: new Date(Date.UTC(2026, 5, 11, 0, 0, seq)),
      updatedAt: new Date(Date.UTC(2026, 5, 11, 0, 1, seq)),
    };
  }

  it('returns { items: [], nextCursor: null } when no provisioning project exists', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.listProjectResources(USER_ID, PROJECT_ID);

    expect(result).toEqual({ items: [], nextCursor: null });
    expect(prisma.provisioningResource.findMany).not.toHaveBeenCalled();
  });

  it('returns items when resources exist', async () => {
    const rows = [stubResourceRow(1), stubResourceRow(2)];
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID, provider: 'noop' });
    prisma.provisioningResource.findMany.mockResolvedValue(rows);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.listProjectResources(USER_ID, PROJECT_ID);

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
    expect(result.items[0].resourceType).toBe('server');
    expect(result.items[0].provider).toBe('noop');
    expect(result.items[0].projectId).toBe(PROJECT_ID);
  });

  it('provider filter: returns empty when query.provider !== pp.provider', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID, provider: 'hetzner' });

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.listProjectResources(USER_ID, PROJECT_ID, { provider: 'docker' });

    expect(result).toEqual({ items: [], nextCursor: null });
    expect(prisma.provisioningResource.findMany).not.toHaveBeenCalled();
  });

  it('status filter: passes status to findMany where clause', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID, provider: 'noop' });
    prisma.provisioningResource.findMany.mockResolvedValue([]);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await svc.listProjectResources(USER_ID, PROJECT_ID, { status: 'DESTROYED' });

    const whereArg = prisma.provisioningResource.findMany.mock.calls[0][0].where;
    expect(whereArg.status).toBe('DESTROYED');
    expect(whereArg.destroyedAt).toBeUndefined();
  });

  it('nextCursor returned when findMany returns limit+1 rows', async () => {
    const rows = [stubResourceRow(1), stubResourceRow(2), stubResourceRow(3)];
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID, provider: 'noop' });
    prisma.provisioningResource.findMany.mockResolvedValue(rows);

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.listProjectResources(USER_ID, PROJECT_ID, { limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
    expect(typeof result.nextCursor).toBe('string');
  });

  it('throws NotFoundException when project not found', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.listProjectResources(USER_ID, 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── ProvisioningService.getResource ──────────────────────────

describe('ProvisioningService.getResource', () => {
  function stubResourceWithProject() {
    return {
      id: 'res-001',
      kind: 'server',
      name: 'web-1',
      status: 'ACTIVE',
      externalId: 'ext-123',
      desiredSpec: { serverType: 'cx11' },
      actualSpec: { ip: '1.2.3.4' },
      destroyedAt: null,
      createdAt: new Date(Date.UTC(2026, 5, 11, 0, 0, 1)),
      updatedAt: new Date(Date.UTC(2026, 5, 11, 0, 1, 0)),
      provisioningProject: {
        projectId: PROJECT_ID,
        provider: 'noop',
        project: { teamId: TEAM_ID },
      },
    };
  }

  it('returns resource detail with projectId and provider from provisioningProject join', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findUnique.mockResolvedValue(stubResourceWithProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma, makeRegistry());
    const result = await svc.getResource(USER_ID, 'res-001');

    expect(result.id).toBe('res-001');
    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.provider).toBe('noop');
    expect(result.resourceType).toBe('server');
    expect(result.status).toBe('ACTIVE');
  });

  it('throws NotFoundException when resource not found', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.getResource(USER_ID, 'missing-res'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when user not a team member', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findUnique.mockResolvedValue(stubResourceWithProject());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma, makeRegistry());
    await expect(
      svc.getResource(USER_ID, 'res-001'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
