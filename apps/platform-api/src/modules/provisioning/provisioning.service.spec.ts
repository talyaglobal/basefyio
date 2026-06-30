import {
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
    },
    provisioningCredentialRef: { findUnique: jest.fn() },
    provisioningOperation: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    provisioningResource: { findMany: jest.fn() },
    provisioningAuditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const merged = { ...defaults, ...overrides };
  merged.$transaction = jest.fn().mockImplementation((cb: any) => cb(merged));
  return merged as any;
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

    const svc = new ProvisioningService(prisma);
    await expect(
      svc.createOperation(USER_ID, { ...BASE_CREATE_OPERATION_DTO, projectId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException when user is not a team member', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma);
    await expect(
      svc.createOperation(USER_ID, BASE_CREATE_OPERATION_DTO),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFoundException when no provisioning project exists for this project', async () => {
    const prisma = makePrisma();
    setupOperationOwnership(prisma, { ppExists: false });

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
    await expect(
      svc.listResources(USER_ID, 'missing-project'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException (not 403) when user is not a team member', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma);
    await expect(
      svc.listResources('other-user', PROJECT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns empty array when no provisioning project exists', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
    const [item] = await svc.listResources(USER_ID, PROJECT_ID);

    expect(item.actualSpec).toBeNull();
  });

  it('does not write any audit events or transactions — pure read', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID });
    prisma.provisioningResource.findMany = jest.fn().mockResolvedValue([]);

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
    await expect(
      svc.getOperation(USER_ID, 'missing-op'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException (not 403) when requester is not a team member', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubFullOp());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma);
    await expect(
      svc.getOperation('other-user', 'op-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns mapped response with correct shape', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubFullOp());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
    const result = await svc.getOperation(USER_ID, 'op-1');

    expect(result.result).toEqual(resultPayload);
    expect(result.error).toBeNull();
  });

  it('does not write any audit events — read-only path', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubFullOp());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
    await expect(
      svc.createProject(USER_ID, { ...BASE_CREATE_PROJECT_DTO, projectId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException when user is not a team member', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject());
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningService(prisma);
    await expect(
      svc.createProject(USER_ID, BASE_CREATE_PROJECT_DTO),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws ForbiddenException when credentialRef belongs to a different team', async () => {
    const prisma = makePrisma();
    prisma.project.findUnique.mockResolvedValue(stubProject('team-A'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf('team-A'));
    prisma.provisioningCredentialRef.findUnique.mockResolvedValue(stubCredRef('team-B'));

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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

    const svc = new ProvisioningService(prisma);
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
