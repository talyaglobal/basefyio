import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { IProvisioningProvider } from './interfaces/provisioning-provider.interface';

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

// ── Fixture constants ────────────────────────────────────────

const TEAM_ID = 'team-1';
const PP_ID = 'pp-1';
const OP_ID = 'op-1';
const USER_ID = 'user-1';
const OPENBAO_PATH = 'secret/provisioning/cred-1';

function stubOp(status = 'PENDING', id = OP_ID) {
  return {
    id,
    status,
    type: 'CREATE',
    input: null,
    provisioningProjectId: PP_ID,
    provisioningProject: {
      id: PP_ID,
      project: { teamId: TEAM_ID },
      credentialRef: { openbaoPath: OPENBAO_PATH },
    },
  };
}

function memberOf(teamId = TEAM_ID) {
  return { teamId, userId: USER_ID };
}

function makeRunningOp() {
  return { ...stubOp('PENDING'), id: OP_ID, status: 'RUNNING' };
}

function makeCompletedOp() {
  return { ...stubOp(), id: OP_ID, status: 'COMPLETED', completedAt: new Date() };
}

function makeFailedOp() {
  return { ...stubOp(), id: OP_ID, status: 'FAILED', errorMessage: 'timeout', completedAt: new Date() };
}

// ── ownership ────────────────────────────────────────────────

describe('ProvisioningExecutorService — ownership', () => {
  it('throws NotFoundException when operation does not exist', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningExecutorService(prisma, makeProvider());
    await expect(svc.executeOperation(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException when caller is not a team member', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(null);

    const svc = new ProvisioningExecutorService(prisma, makeProvider());
    await expect(svc.executeOperation(USER_ID, OP_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ── invalid transitions ──────────────────────────────────────

describe('ProvisioningExecutorService — invalid transitions', () => {
  const nonExecutableStatuses = [
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'DRY_RUN',
    'ROLLED_BACK',
  ];

  for (const status of nonExecutableStatuses) {
    it(`throws BadRequestException for status ${status}`, async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp(status));
      prisma.teamMember.findUnique.mockResolvedValue(memberOf());

      const svc = new ProvisioningExecutorService(prisma, makeProvider());
      await expect(svc.executeOperation(USER_ID, OP_ID)).rejects.toBeInstanceOf(BadRequestException);
    });
  }
});

// ── noop success ─────────────────────────────────────────────

describe('ProvisioningExecutorService — noop success', () => {
  it('transitions PENDING → RUNNING → COMPLETED and returns completed operation', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    // first update: RUNNING; second update: COMPLETED
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const svc = new ProvisioningExecutorService(prisma, makeProvider());
    const result = await svc.executeOperation(USER_ID, OP_ID);

    expect(result.status).toBe('COMPLETED');
  });

  it('calls update with RUNNING then COMPLETED in order', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const svc = new ProvisioningExecutorService(prisma, makeProvider());
    await svc.executeOperation(USER_ID, OP_ID);

    const updateCalls = prisma.provisioningOperation.update.mock.calls;
    expect(updateCalls[0][0].data.status).toBe('RUNNING');
    expect(updateCalls[1][0].data.status).toBe('COMPLETED');
  });

  it('passes openbaoPath to provider — not credential bytes', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const provider = makeProvider();
    const svc = new ProvisioningExecutorService(prisma, provider);
    await svc.executeOperation(USER_ID, OP_ID);

    const providerCall = (provider.execute as jest.Mock).mock.calls[0][0];
    expect(providerCall.credentialOpenbaoPath).toBe(OPENBAO_PATH);
  });
});

// ── noop failure ─────────────────────────────────────────────

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

    const svc = new ProvisioningExecutorService(prisma, provider);
    const result = await svc.executeOperation(USER_ID, OP_ID);

    expect(result.status).toBe('FAILED');
  });

  it('sets errorMessage on failed update', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.execute as jest.Mock).mockRejectedValue(new Error('provider timeout'));

    const svc = new ProvisioningExecutorService(prisma, provider);
    await svc.executeOperation(USER_ID, OP_ID);

    const failUpdate = prisma.provisioningOperation.update.mock.calls[1][0];
    expect(failUpdate.data.status).toBe('FAILED');
    expect(failUpdate.data.errorMessage).toBe('provider timeout');
  });

  it('does not throw — failed operations are returned, not re-thrown', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeFailedOp());

    const provider = makeProvider();
    (provider.execute as jest.Mock).mockRejectedValue(new Error('boom'));

    const svc = new ProvisioningExecutorService(prisma, provider);
    await expect(svc.executeOperation(USER_ID, OP_ID)).resolves.toBeDefined();
  });
});

// ── audit sequence ────────────────────────────────────────────

describe('ProvisioningExecutorService — audit sequence', () => {
  it('emits STATUS_CHANGED(PENDING→RUNNING) then OPERATION_COMPLETED(RUNNING→COMPLETED) on success', async () => {
    const prisma = makePrisma();
    prisma.provisioningOperation.findUnique.mockResolvedValue(stubOp('PENDING'));
    prisma.teamMember.findUnique.mockResolvedValue(memberOf());
    prisma.provisioningOperation.update
      .mockResolvedValueOnce(makeRunningOp())
      .mockResolvedValueOnce(makeCompletedOp());

    const svc = new ProvisioningExecutorService(prisma, makeProvider());
    await svc.executeOperation(USER_ID, OP_ID);

    const auditCalls = prisma.provisioningAuditEvent.create.mock.calls;
    expect(auditCalls).toHaveLength(2);

    const [first, second] = auditCalls.map((c: any) => c[0].data);
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

    const svc = new ProvisioningExecutorService(prisma, provider);
    await svc.executeOperation(USER_ID, OP_ID);

    const auditCalls = prisma.provisioningAuditEvent.create.mock.calls;
    expect(auditCalls).toHaveLength(2);

    const [first, second] = auditCalls.map((c: any) => c[0].data);
    expect(first.kind).toBe('STATUS_CHANGED');
    expect(first.fromStatus).toBe('PENDING');
    expect(first.toStatus).toBe('RUNNING');

    expect(second.kind).toBe('OPERATION_FAILED');
    expect(second.fromStatus).toBe('RUNNING');
    expect(second.toStatus).toBe('FAILED');
  });
});
