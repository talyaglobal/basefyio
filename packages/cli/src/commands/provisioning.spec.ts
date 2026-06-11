import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (must be defined before vi.mock factories run) ──────────────

const { mockApiClient } = vi.hoisted(() => {
  const mockApiClient = {
    listProvisioningOperations: vi.fn(),
    getProvisioningOperation: vi.fn(),
    cancelProvisioningOperation: vi.fn(),
    getProvisioningOperationEvents: vi.fn(),
    createProvisioningCredentialRef: vi.fn(),
    listProvisioningCredentialRefs: vi.fn(),
    revokeProvisioningCredentialRef: vi.fn(),
  };
  return { mockApiClient };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../lib/config.js', () => ({
  isLoggedIn: vi.fn().mockReturnValue(true),
  getProjectConfig: vi.fn(),
}));

vi.mock('../lib/ui.js', () => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  createSpinner: vi.fn().mockReturnValue({ stop: vi.fn() }),
  printTable: vi.fn(),
  printHeader: vi.fn(),
  printKeyValue: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  apiClient: mockApiClient,
  handleApiError: vi.fn().mockImplementation(async (err) => { throw err; }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  listOperations,
  getOperation,
  cancelOperation,
  createCredentialRef,
  listCredentialRefs,
  revokeCredentialRef,
  watchOperation,
  logsOperation,
} from './provisioning.js';

import { success, info, error, printTable } from '../lib/ui.js';
import { isLoggedIn } from '../lib/config.js';
import { handleApiError } from '../lib/api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-123';
const OP_ID      = 'op-456';
const CRED_ID    = 'cred-789';
const TEAM_ID    = 'team-abc';

function makeOp(overrides: Record<string, unknown> = {}) {
  return {
    provisioningOperationId: OP_ID,
    status: 'PENDING',
    type: 'CREATE',
    dryRun: false,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
    result: null,
    ...overrides,
  };
}

function makeRef(overrides: Record<string, unknown> = {}) {
  return {
    credentialRefId: CRED_ID,
    teamId: TEAM_ID,
    label: 'prod',
    openbaoPath: 'secret/hetzner/prod',
    provider: 'hetzner',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLoggedIn).mockReturnValue(true);
});

// ── listOperations ────────────────────────────────────────────────────────────

describe('listOperations', () => {
  it('calls listProvisioningOperations with projectId and renders table', async () => {
    mockApiClient.listProvisioningOperations.mockResolvedValue([makeOp()]);

    await listOperations({ projectId: PROJECT_ID });

    expect(mockApiClient.listProvisioningOperations).toHaveBeenCalledWith(PROJECT_ID, {
      status: undefined,
      limit: undefined,
    });
  });

  it('passes status filter to apiClient', async () => {
    mockApiClient.listProvisioningOperations.mockResolvedValue([]);

    await listOperations({ projectId: PROJECT_ID, status: 'PENDING' });

    expect(mockApiClient.listProvisioningOperations).toHaveBeenCalledWith(PROJECT_ID, {
      status: 'PENDING',
      limit: undefined,
    });
  });

  it('parses limit string to int', async () => {
    mockApiClient.listProvisioningOperations.mockResolvedValue([]);

    await listOperations({ projectId: PROJECT_ID, limit: '10' });

    expect(mockApiClient.listProvisioningOperations).toHaveBeenCalledWith(PROJECT_ID, {
      status: undefined,
      limit: 10,
    });
  });

  it('shows info message when no operations found', async () => {
    mockApiClient.listProvisioningOperations.mockResolvedValue([]);

    await listOperations({ projectId: PROJECT_ID });

    expect(info).toHaveBeenCalledWith(expect.stringContaining('No operations'));
  });

  it('calls handleApiError on 401', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockApiClient.listProvisioningOperations.mockRejectedValue(err);

    await expect(listOperations({ projectId: PROJECT_ID })).rejects.toThrow('Unauthorized');
    expect(handleApiError).toHaveBeenCalledWith(err);
  });
});

// ── getOperation ──────────────────────────────────────────────────────────────

describe('getOperation', () => {
  it('calls getProvisioningOperation with correct id', async () => {
    mockApiClient.getProvisioningOperation.mockResolvedValue(makeOp({ status: 'COMPLETED' }));

    await getOperation(OP_ID);

    expect(mockApiClient.getProvisioningOperation).toHaveBeenCalledWith(OP_ID);
  });

  it('calls handleApiError on 404', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    mockApiClient.getProvisioningOperation.mockRejectedValue(err);

    await expect(getOperation(OP_ID)).rejects.toThrow('Not Found');
    expect(handleApiError).toHaveBeenCalledWith(err);
  });
});

// ── cancelOperation ───────────────────────────────────────────────────────────

describe('cancelOperation', () => {
  it('calls cancelProvisioningOperation and shows success', async () => {
    mockApiClient.cancelProvisioningOperation.mockResolvedValue(makeOp({ status: 'CANCELLED' }));

    await cancelOperation(OP_ID);

    expect(mockApiClient.cancelProvisioningOperation).toHaveBeenCalledWith(OP_ID);
    expect(success).toHaveBeenCalledWith(expect.stringContaining(OP_ID));
  });

  it('calls handleApiError when op is not PENDING (400)', async () => {
    const err = Object.assign(new Error('Only PENDING operations can be cancelled'), { status: 400 });
    mockApiClient.cancelProvisioningOperation.mockRejectedValue(err);

    await expect(cancelOperation(OP_ID)).rejects.toThrow();
    expect(handleApiError).toHaveBeenCalledWith(err);
  });

  it('calls handleApiError on 403', async () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    mockApiClient.cancelProvisioningOperation.mockRejectedValue(err);

    await expect(cancelOperation(OP_ID)).rejects.toThrow('Forbidden');
    expect(handleApiError).toHaveBeenCalledWith(err);
  });
});

// ── createCredentialRef ───────────────────────────────────────────────────────

describe('createCredentialRef', () => {
  it('calls createProvisioningCredentialRef with mapped body', async () => {
    mockApiClient.createProvisioningCredentialRef.mockResolvedValue(makeRef());

    await createCredentialRef({ teamId: TEAM_ID, label: 'prod', path: 'secret/hetzner/prod' });

    expect(mockApiClient.createProvisioningCredentialRef).toHaveBeenCalledWith({
      teamId: TEAM_ID,
      label: 'prod',
      openbaoPath: 'secret/hetzner/prod',
      provider: undefined,
    });
    expect(success).toHaveBeenCalledWith(expect.stringContaining(CRED_ID));
  });

  it('passes provider when supplied', async () => {
    mockApiClient.createProvisioningCredentialRef.mockResolvedValue(makeRef());

    await createCredentialRef({ teamId: TEAM_ID, label: 'prod', path: 'secret/hetzner/prod', provider: 'hetzner' });

    expect(mockApiClient.createProvisioningCredentialRef).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'hetzner' }),
    );
  });

  it('calls handleApiError on 403', async () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    mockApiClient.createProvisioningCredentialRef.mockRejectedValue(err);

    await expect(createCredentialRef({ teamId: TEAM_ID, label: 'prod', path: 'secret/hetzner/prod' })).rejects.toThrow();
    expect(handleApiError).toHaveBeenCalledWith(err);
  });
});

// ── listCredentialRefs ────────────────────────────────────────────────────────

describe('listCredentialRefs', () => {
  it('calls listProvisioningCredentialRefs with teamId', async () => {
    mockApiClient.listProvisioningCredentialRefs.mockResolvedValue([makeRef()]);

    await listCredentialRefs({ teamId: TEAM_ID });

    expect(mockApiClient.listProvisioningCredentialRefs).toHaveBeenCalledWith(TEAM_ID);
  });

  it('shows info when no refs found', async () => {
    mockApiClient.listProvisioningCredentialRefs.mockResolvedValue([]);

    await listCredentialRefs({ teamId: TEAM_ID });

    expect(info).toHaveBeenCalledWith(expect.stringContaining('No credential refs'));
  });

  it('calls handleApiError on 401', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockApiClient.listProvisioningCredentialRefs.mockRejectedValue(err);

    await expect(listCredentialRefs({ teamId: TEAM_ID })).rejects.toThrow();
    expect(handleApiError).toHaveBeenCalledWith(err);
  });
});

// ── revokeCredentialRef ───────────────────────────────────────────────────────

describe('revokeCredentialRef', () => {
  it('calls revokeProvisioningCredentialRef and shows success', async () => {
    mockApiClient.revokeProvisioningCredentialRef.mockResolvedValue(undefined);

    await revokeCredentialRef(CRED_ID);

    expect(mockApiClient.revokeProvisioningCredentialRef).toHaveBeenCalledWith(CRED_ID);
    expect(success).toHaveBeenCalledWith(expect.stringContaining(CRED_ID));
  });

  it('calls handleApiError on 409 (already revoked)', async () => {
    const err = Object.assign(new Error('Already revoked'), { status: 409 });
    mockApiClient.revokeProvisioningCredentialRef.mockRejectedValue(err);

    await expect(revokeCredentialRef(CRED_ID)).rejects.toThrow('Already revoked');
    expect(handleApiError).toHaveBeenCalledWith(err);
  });

  it('calls handleApiError on 404', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    mockApiClient.revokeProvisioningCredentialRef.mockRejectedValue(err);

    await expect(revokeCredentialRef(CRED_ID)).rejects.toThrow();
    expect(handleApiError).toHaveBeenCalledWith(err);
  });
});

// ── watchOperation ────────────────────────────────────────────────────────────

describe('watchOperation', () => {
  it('exits immediately on COMPLETED and calls success', async () => {
    mockApiClient.getProvisioningOperation.mockResolvedValue(
      makeOp({ status: 'COMPLETED', error: null, result: null }),
    );
    await watchOperation(OP_ID, { intervalSecs: '0' });
    expect(success).toHaveBeenCalledWith(expect.stringContaining(OP_ID));
  });

  it('exits immediately on FAILED and calls error', async () => {
    mockApiClient.getProvisioningOperation.mockResolvedValue(
      makeOp({ status: 'FAILED', error: null, result: null }),
    );
    await watchOperation(OP_ID, { intervalSecs: '0' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(OP_ID));
  });

  it('exits immediately on CANCELLED and calls error', async () => {
    mockApiClient.getProvisioningOperation.mockResolvedValue(
      makeOp({ status: 'CANCELLED', error: null, result: null }),
    );
    await watchOperation(OP_ID, { intervalSecs: '0' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(OP_ID));
  });

  it('polls until COMPLETED — calls getProvisioningOperation twice and success once', async () => {
    mockApiClient.getProvisioningOperation
      .mockResolvedValueOnce(makeOp({ status: 'PENDING' }))
      .mockResolvedValueOnce(makeOp({ status: 'COMPLETED', error: null, result: null }));
    await watchOperation(OP_ID, { intervalSecs: '0' });
    expect(mockApiClient.getProvisioningOperation).toHaveBeenCalledTimes(2);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('calls handleApiError when getProvisioningOperation rejects', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    mockApiClient.getProvisioningOperation.mockRejectedValue(err);
    await expect(watchOperation(OP_ID, { intervalSecs: '0' })).rejects.toThrow('Not Found');
    expect(handleApiError).toHaveBeenCalledWith(err);
  });
});

// ── logsOperation ─────────────────────────────────────────────────────────────

describe('logsOperation', () => {
  it('renders event table when events exist', async () => {
    const event = {
      id: 'evt-1',
      kind: 'STATUS_CHANGED',
      fromStatus: 'PENDING',
      toStatus: 'COMPLETED',
      actorUserId: null,
      metadata: null,
      createdAt: new Date().toISOString(),
    };
    mockApiClient.getProvisioningOperationEvents.mockResolvedValue([event]);

    await logsOperation(OP_ID);

    expect(mockApiClient.getProvisioningOperationEvents).toHaveBeenCalledWith(OP_ID);
    expect(printTable).toHaveBeenCalled();
  });

  it('shows info when no events', async () => {
    mockApiClient.getProvisioningOperationEvents.mockResolvedValue([]);

    await logsOperation(OP_ID);

    expect(info).toHaveBeenCalledWith(expect.stringContaining('No events'));
  });

  it('calls handleApiError on 404', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    mockApiClient.getProvisioningOperationEvents.mockRejectedValue(err);

    await expect(logsOperation(OP_ID)).rejects.toThrow('Not Found');
    expect(handleApiError).toHaveBeenCalledWith(err);
  });
});
