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
