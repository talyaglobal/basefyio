import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProvisioningClient } from './provisioning.js';
import type { BasefyioFetchClient } from '../lib/fetch.js';

// ── Minimal fetch client stub ─────────────────────────────────────────────────

function makeHttp(overrides: Partial<BasefyioFetchClient> = {}): BasefyioFetchClient {
  return {
    json: vi.fn(),
    request: vi.fn(),
    blob: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue('https://api.basefyio.com/api'),
    ...overrides,
  } as unknown as BasefyioFetchClient;
}

const PROJECT_ID   = 'proj-123';
const PP_ID        = 'pp-456';
const OP_ID        = 'op-789';
const CRED_ID      = 'cred-abc';
const TEAM_ID      = 'team-xyz';
const IDEM_KEY     = 'idem-1';

// ── createProject ─────────────────────────────────────────────────────────────

describe('ProvisioningClient.createProject', () => {
  it('POSTs to /v1/provisioning/projects and returns data', async () => {
    const mockResult = { provisioningProjectId: PP_ID, provider: 'hetzner', status: 'PENDING', operation: { provisioningOperationId: OP_ID, status: 'PENDING', dryRun: false, idempotent: false } };
    const http = makeHttp({ json: vi.fn().mockResolvedValue(mockResult) });
    const client = new ProvisioningClient(http);

    const res = await client.createProject({ projectId: PROJECT_ID, credentialRefId: CRED_ID, region: 'eu-central', desiredSpec: {}, dryRun: false, idempotencyKey: IDEM_KEY });

    expect(res.data).toEqual(mockResult);
    expect(res.error).toBeNull();
    expect(http.json).toHaveBeenCalledWith('/v1/provisioning/projects', expect.objectContaining({ method: 'POST' }));
  });

  it('returns error on HTTP failure', async () => {
    const http = makeHttp({ json: vi.fn().mockRejectedValue({ message: 'Forbidden', status: 403 }) });
    const client = new ProvisioningClient(http);

    const res = await client.createProject({ projectId: PROJECT_ID, credentialRefId: CRED_ID, region: 'eu-central', desiredSpec: {}, dryRun: false, idempotencyKey: IDEM_KEY });

    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(403);
  });
});

// ── getProject ────────────────────────────────────────────────────────────────

describe('ProvisioningClient.getProject', () => {
  it('GETs /v1/provisioning/projects?projectId=... and returns project status', async () => {
    const mockPP = { provisioningProjectId: PP_ID, provider: 'hetzner', region: 'eu-central', datacenter: null, status: 'ACTIVE', createdAt: '2026-06-11T00:00:00.000Z' };
    const http = makeHttp({ json: vi.fn().mockResolvedValue(mockPP) });
    const client = new ProvisioningClient(http);

    const res = await client.getProject(PROJECT_ID);

    expect(res.data?.provisioningProjectId).toBe(PP_ID);
    expect(res.data?.status).toBe('ACTIVE');
    expect((http.json as any).mock.calls[0][0]).toContain('projectId=');
  });

  it('returns error when project not found (404)', async () => {
    const http = makeHttp({ json: vi.fn().mockRejectedValue({ message: 'Not found', status: 404 }) });
    const client = new ProvisioningClient(http);

    const res = await client.getProject('missing-id');

    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(404);
  });
});

// ── createOperation ───────────────────────────────────────────────────────────

describe('ProvisioningClient.createOperation', () => {
  it('POSTs to /v1/provisioning/operations and returns PENDING operation', async () => {
    const mockOp = { id: OP_ID, projectId: PROJECT_ID, type: 'CREATE', status: 'PENDING', dryRun: false, idempotencyKey: IDEM_KEY, input: {}, result: null, error: null, createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-11T00:00:00.000Z', startedAt: null, completedAt: null };
    const http = makeHttp({ json: vi.fn().mockResolvedValue(mockOp) });
    const client = new ProvisioningClient(http);

    const res = await client.createOperation({ projectId: PROJECT_ID, type: 'CREATE', idempotencyKey: IDEM_KEY, desiredSpec: {}, dryRun: false });

    expect(res.data?.status).toBe('PENDING');
    expect(res.error).toBeNull();
    expect(http.json).toHaveBeenCalledWith('/v1/provisioning/operations', expect.objectContaining({ method: 'POST' }));
  });

  it('returns DRY_RUN status when dryRun=true', async () => {
    const mockOp = { id: OP_ID, status: 'DRY_RUN', dryRun: true };
    const http = makeHttp({ json: vi.fn().mockResolvedValue(mockOp) });
    const client = new ProvisioningClient(http);

    const res = await client.createOperation({ projectId: PROJECT_ID, type: 'CREATE', idempotencyKey: IDEM_KEY, desiredSpec: {}, dryRun: true });

    expect(res.data?.status).toBe('DRY_RUN');
  });
});

// ── listOperations ────────────────────────────────────────────────────────────

describe('ProvisioningClient.listOperations', () => {
  it('GETs /v1/provisioning/operations with projectId param', async () => {
    const http = makeHttp({ json: vi.fn().mockResolvedValue([]) });
    const client = new ProvisioningClient(http);

    const res = await client.listOperations({ projectId: PROJECT_ID });

    expect(res.data).toEqual([]);
    const url: string = (http.json as any).mock.calls[0][0];
    expect(url).toContain(`projectId=${PROJECT_ID}`);
  });

  it('appends status filter when provided', async () => {
    const http = makeHttp({ json: vi.fn().mockResolvedValue([]) });
    const client = new ProvisioningClient(http);

    await client.listOperations({ projectId: PROJECT_ID, status: 'PENDING' });

    const url: string = (http.json as any).mock.calls[0][0];
    expect(url).toContain('status=PENDING');
  });

  it('appends limit when provided', async () => {
    const http = makeHttp({ json: vi.fn().mockResolvedValue([]) });
    const client = new ProvisioningClient(http);

    await client.listOperations({ projectId: PROJECT_ID, limit: 5 });

    const url: string = (http.json as any).mock.calls[0][0];
    expect(url).toContain('limit=5');
  });
});

// ── getOperation ──────────────────────────────────────────────────────────────

describe('ProvisioningClient.getOperation', () => {
  it('GETs /v1/provisioning/operations/:id', async () => {
    const mockOp = { id: OP_ID, status: 'COMPLETED' };
    const http = makeHttp({ json: vi.fn().mockResolvedValue(mockOp) });
    const client = new ProvisioningClient(http);

    const res = await client.getOperation(OP_ID);

    expect(res.data?.id).toBe(OP_ID);
    expect((http.json as any).mock.calls[0][0]).toBe(`/v1/provisioning/operations/${OP_ID}`);
  });
});

// ── cancelOperation ───────────────────────────────────────────────────────────

describe('ProvisioningClient.cancelOperation', () => {
  it('POSTs to /operations/:id/cancel and returns CANCELLED operation', async () => {
    const mockOp = { id: OP_ID, status: 'CANCELLED' };
    const http = makeHttp({ json: vi.fn().mockResolvedValue(mockOp) });
    const client = new ProvisioningClient(http);

    const res = await client.cancelOperation(OP_ID);

    expect(res.data?.status).toBe('CANCELLED');
    expect(http.json).toHaveBeenCalledWith(
      `/v1/provisioning/operations/${OP_ID}/cancel`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns error when op is not PENDING (400)', async () => {
    const http = makeHttp({ json: vi.fn().mockRejectedValue({ message: 'Only PENDING operations can be cancelled', status: 400 }) });
    const client = new ProvisioningClient(http);

    const res = await client.cancelOperation(OP_ID);

    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(400);
  });
});

// ── executeOperation ──────────────────────────────────────────────────────────

describe('ProvisioningClient.executeOperation', () => {
  it('POSTs to /operations/:id/execute', async () => {
    const http = makeHttp({ json: vi.fn().mockResolvedValue({ id: OP_ID, status: 'COMPLETED' }) });
    const client = new ProvisioningClient(http);

    const res = await client.executeOperation(OP_ID);

    expect(res.data?.status).toBe('COMPLETED');
    expect(http.json).toHaveBeenCalledWith(
      `/v1/provisioning/operations/${OP_ID}/execute`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── listResources ─────────────────────────────────────────────────────────────

describe('ProvisioningClient.listResources', () => {
  it('GETs /v1/provisioning/resources?projectId=...', async () => {
    const http = makeHttp({ json: vi.fn().mockResolvedValue([]) });
    const client = new ProvisioningClient(http);

    await client.listResources(PROJECT_ID);

    const url: string = (http.json as any).mock.calls[0][0];
    expect(url).toContain(`projectId=${PROJECT_ID}`);
    expect(url).not.toContain('includeDestroyed');
  });

  it('appends includeDestroyed=true when option is set', async () => {
    const http = makeHttp({ json: vi.fn().mockResolvedValue([]) });
    const client = new ProvisioningClient(http);

    await client.listResources(PROJECT_ID, { includeDestroyed: true });

    const url: string = (http.json as any).mock.calls[0][0];
    expect(url).toContain('includeDestroyed=true');
  });
});

// ── credential refs ───────────────────────────────────────────────────────────

describe('ProvisioningClient.createCredentialRef', () => {
  it('POSTs to /v1/provisioning/credentials and returns created ref', async () => {
    const mockRef = { credentialRefId: CRED_ID, teamId: TEAM_ID, label: 'prod', openbaoPath: 'secret/hetzner/prod', provider: 'hetzner', createdAt: '2026-06-11T00:00:00.000Z' };
    const http = makeHttp({ json: vi.fn().mockResolvedValue(mockRef) });
    const client = new ProvisioningClient(http);

    const res = await client.createCredentialRef({ teamId: TEAM_ID, label: 'prod', openbaoPath: 'secret/hetzner/prod' });

    expect(res.data?.credentialRefId).toBe(CRED_ID);
    expect(http.json).toHaveBeenCalledWith('/v1/provisioning/credentials', expect.objectContaining({ method: 'POST' }));
  });

  it('returns 403 error when user is not a team member', async () => {
    const http = makeHttp({ json: vi.fn().mockRejectedValue({ message: 'Forbidden', status: 403 }) });
    const client = new ProvisioningClient(http);

    const res = await client.createCredentialRef({ teamId: TEAM_ID, label: 'prod', openbaoPath: 'secret/hetzner/prod' });

    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(403);
  });
});

describe('ProvisioningClient.listCredentialRefs', () => {
  it('GETs /v1/provisioning/credentials?teamId=...', async () => {
    const http = makeHttp({ json: vi.fn().mockResolvedValue([]) });
    const client = new ProvisioningClient(http);

    const res = await client.listCredentialRefs(TEAM_ID);

    expect(res.data).toEqual([]);
    const url: string = (http.json as any).mock.calls[0][0];
    expect(url).toContain(`teamId=${TEAM_ID}`);
  });
});

describe('ProvisioningClient.revokeCredentialRef', () => {
  it('DELETEs /v1/provisioning/credentials/:id and returns null data', async () => {
    const http = makeHttp({ request: vi.fn().mockResolvedValue({ data: null, response: new Response(null, { status: 204 }) }) });
    const client = new ProvisioningClient(http);

    const res = await client.revokeCredentialRef(CRED_ID);

    expect(res.data).toBeNull();
    expect(res.error).toBeNull();
    expect(http.request).toHaveBeenCalledWith(
      `/v1/provisioning/credentials/${CRED_ID}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns 409 error when already revoked', async () => {
    const http = makeHttp({ request: vi.fn().mockRejectedValue({ message: 'Already revoked', status: 409 }) });
    const client = new ProvisioningClient(http);

    const res = await client.revokeCredentialRef(CRED_ID);

    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(409);
  });
});

// ── error mapping ─────────────────────────────────────────────────────────────

describe('ProvisioningClient — error status mapping', () => {
  const METHODS = [
    ['createProject', (c: ProvisioningClient) => c.createProject({ projectId: 'p', credentialRefId: 'c', region: 'eu', desiredSpec: {}, dryRun: false, idempotencyKey: 'k' })],
    ['getProject', (c: ProvisioningClient) => c.getProject('p')],
    ['createOperation', (c: ProvisioningClient) => c.createOperation({ projectId: 'p', type: 'CREATE', idempotencyKey: 'k', desiredSpec: {}, dryRun: false })],
    ['listOperations', (c: ProvisioningClient) => c.listOperations({ projectId: 'p' })],
    ['getOperation', (c: ProvisioningClient) => c.getOperation('op-id')],
    ['cancelOperation', (c: ProvisioningClient) => c.cancelOperation('op-id')],
    ['executeOperation', (c: ProvisioningClient) => c.executeOperation('op-id')],
    ['listResources', (c: ProvisioningClient) => c.listResources('p')],
    ['listCredentialRefs', (c: ProvisioningClient) => c.listCredentialRefs('t')],
  ] as const;

  for (const [name, call] of METHODS) {
    it(`${name}: 401 error surfaces in error.status`, async () => {
      const http = makeHttp({
        json: vi.fn().mockRejectedValue({ message: 'Unauthorized', status: 401 }),
        request: vi.fn().mockRejectedValue({ message: 'Unauthorized', status: 401 }),
      });
      const client = new ProvisioningClient(http);
      const res = await call(client);
      expect(res.data).toBeNull();
      expect(res.error?.status).toBe(401);
    });
  }
});
