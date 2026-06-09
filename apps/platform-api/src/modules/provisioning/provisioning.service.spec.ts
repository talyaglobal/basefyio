import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { OperationTypeDto } from './dto/create-provisioning-operation.dto';

// ── Prisma mock factory ──────────────────────────────────────
//
// $transaction is mocked to call the callback synchronously with the same
// mock object as `tx`, so assertions on e.g. provisioningOperation.create
// still work without duplicating every mock per-method.

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

const BASE_CREATE_PROJECT_DTO = {
  projectId: PROJECT_ID,
  credentialRefId: CRED_ID,
  region: 'eu-central',
  desiredSpec: { serverType: 'cx21' },
  dryRun: false,
  idempotencyKey: IDEM_KEY,
};

// ── createOperation — idempotency ───────────────────────────

describe('ProvisioningService.createOperation', () => {
  describe('idempotency', () => {
    it('returns existing operation and idempotent=true when key already exists', async () => {
      const existingOp = { id: 'op-existing', status: 'PENDING', idempotencyKey: IDEM_KEY };
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(stubProvisioningProject());
      prisma.teamMember.findUnique.mockResolvedValue(memberOf());
      prisma.provisioningOperation.findUnique.mockResolvedValue(existingOp);

      const svc = new ProvisioningService(prisma);
      const result = await svc.createOperation(USER_ID, {
        provisioningProjectId: PP_ID,
        type: OperationTypeDto.CREATE,
        dryRun: false,
        idempotencyKey: IDEM_KEY,
      });

      expect(result).toEqual({ operation: existingOp, idempotent: true });
      expect(prisma.provisioningOperation.create).not.toHaveBeenCalled();
    });

    it('does not write an audit event on idempotent replay', async () => {
      const existingOp = { id: 'op-existing', status: 'PENDING', idempotencyKey: IDEM_KEY };
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(stubProvisioningProject());
      prisma.teamMember.findUnique.mockResolvedValue(memberOf());
      prisma.provisioningOperation.findUnique.mockResolvedValue(existingOp);

      const svc = new ProvisioningService(prisma);
      await svc.createOperation(USER_ID, {
        provisioningProjectId: PP_ID,
        type: OperationTypeDto.CREATE,
        dryRun: false,
        idempotencyKey: IDEM_KEY,
      });

      expect(prisma.provisioningAuditEvent.create).not.toHaveBeenCalled();
    });

    it('creates a new operation and sets idempotent=false on first call', async () => {
      const newOp = { id: 'op-new', status: 'PENDING', idempotencyKey: IDEM_KEY };
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(stubProvisioningProject());
      prisma.teamMember.findUnique.mockResolvedValue(memberOf());
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      prisma.provisioningOperation.create.mockResolvedValue(newOp);

      const svc = new ProvisioningService(prisma);
      const result = await svc.createOperation(USER_ID, {
        provisioningProjectId: PP_ID,
        type: OperationTypeDto.CREATE,
        dryRun: false,
        idempotencyKey: IDEM_KEY,
      });

      expect(result).toEqual({ operation: newOp, idempotent: false });
      expect(prisma.provisioningOperation.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('dryRun', () => {
    it('sets status to DRY_RUN immediately and emits DRY_RUN_COMPLETED audit event', async () => {
      const dryOp = { id: 'op-dry', status: 'DRY_RUN', idempotencyKey: IDEM_KEY };
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(stubProvisioningProject());
      prisma.teamMember.findUnique.mockResolvedValue(memberOf());
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      prisma.provisioningOperation.create.mockResolvedValue(dryOp);

      const svc = new ProvisioningService(prisma);
      const result = await svc.createOperation(USER_ID, {
        provisioningProjectId: PP_ID,
        type: OperationTypeDto.CREATE,
        dryRun: true,
        idempotencyKey: IDEM_KEY,
      });

      expect(result.operation.status).toBe('DRY_RUN');
      const createCall = prisma.provisioningOperation.create.mock.calls[0][0];
      expect(createCall.data.status).toBe('DRY_RUN');
      expect(createCall.data.dryRun).toBe(true);
      expect(createCall.data.completedAt).toBeDefined();

      const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0];
      expect(auditCall.data.kind).toBe('DRY_RUN_COMPLETED');
    });

    it('sets status to PENDING (not DRY_RUN) when dryRun=false', async () => {
      const pendingOp = { id: 'op-pending', status: 'PENDING', idempotencyKey: IDEM_KEY };
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(stubProvisioningProject());
      prisma.teamMember.findUnique.mockResolvedValue(memberOf());
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      prisma.provisioningOperation.create.mockResolvedValue(pendingOp);

      const svc = new ProvisioningService(prisma);
      await svc.createOperation(USER_ID, {
        provisioningProjectId: PP_ID,
        type: OperationTypeDto.CREATE,
        dryRun: false,
        idempotencyKey: IDEM_KEY,
      });

      const createCall = prisma.provisioningOperation.create.mock.calls[0][0];
      expect(createCall.data.status).toBe('PENDING');
      expect(createCall.data.completedAt).toBeUndefined();

      const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0];
      expect(auditCall.data.kind).toBe('OPERATION_STARTED');
    });
  });

  describe('ownership', () => {
    it('throws ForbiddenException when user is not a team member', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(stubProvisioningProject());
      prisma.teamMember.findUnique.mockResolvedValue(null);

      const svc = new ProvisioningService(prisma);
      await expect(
        svc.createOperation(USER_ID, {
          provisioningProjectId: PP_ID,
          type: OperationTypeDto.CREATE,
          dryRun: false,
          idempotencyKey: IDEM_KEY,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFoundException when provisioning project does not exist', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(null);

      const svc = new ProvisioningService(prisma);
      await expect(
        svc.createOperation(USER_ID, {
          provisioningProjectId: 'missing',
          type: OperationTypeDto.CREATE,
          dryRun: false,
          idempotencyKey: IDEM_KEY,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

// ── createProject ────────────────────────────────────────────

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
    // Project exists
    prisma.provisioningProject.findUnique.mockResolvedValue({ id: PP_ID });
    // But no operation with this idempotency key
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

// ── ROLLBACK emits ROLLBACK_INITIATED ───────────────────────

describe('ProvisioningService.createOperation — ROLLBACK type', () => {
  it('emits ROLLBACK_INITIATED audit event in addition to OPERATION_STARTED', async () => {
    const newOp = { id: 'op-rb', status: 'PENDING', idempotencyKey: 'rb-key' };
    const prisma = makePrisma();
    prisma.provisioningProject.findUnique.mockResolvedValue(stubProvisioningProject());
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);
    prisma.provisioningOperation.create.mockResolvedValue(newOp);

    const svc = new ProvisioningService(prisma);
    await svc.createOperation(USER_ID, {
      provisioningProjectId: PP_ID,
      type: OperationTypeDto.ROLLBACK,
      dryRun: false,
      idempotencyKey: 'rb-key',
    });

    const auditKinds = prisma.provisioningAuditEvent.create.mock.calls.map(
      (c: any) => c[0].data.kind,
    );
    expect(auditKinds).toContain('OPERATION_STARTED');
    expect(auditKinds).toContain('ROLLBACK_INITIATED');
  });
});
