import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockApiClient, mockPrintKeyValue } = vi.hoisted(() => {
  const mockApiClient = {
    gatewayConnect: vi.fn(),
    gatewayQuery: vi.fn(),
    gatewayPolicy: vi.fn(),
    gatewayHealth: vi.fn(),
  };
  const mockPrintKeyValue = vi.fn();
  return { mockApiClient, mockPrintKeyValue };
});

vi.mock('../lib/api.js', () => ({
  apiClient: mockApiClient,
  handleApiError: vi.fn().mockImplementation(async (err: unknown) => { throw err; }),
}));

vi.mock('../lib/ui.js', () => ({ printKeyValue: mockPrintKeyValue }));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { gatewayConnect, gatewayQuery, gatewayPolicy, gatewayHealth } from './gateway.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-gw-1';
const CERT_ID = 'cert-abc';

const MOCK_POLICY = {
  requireMtls: true,
  allowedAccess: 'READ_WRITE',
  maxConnections: 5,
  queryTimeoutMs: 30_000,
  maxRowLimit: 1_000,
  maxPayloadBytes: 5 * 1024 * 1024,
  providerType: 'postgres-jsonb',
};

const MOCK_CONNECT_RESPONSE = {
  certId: CERT_ID,
  accessLevel: 'READ_WRITE',
  policy: MOCK_POLICY,
  status: 'connected',
};

function axiosErr(status: number, message: string) {
  return { response: { status, data: { message } }, request: {}, isAxiosError: true };
}

// ── Shared spies ──────────────────────────────────────────────────────────────

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(
    (_code?: string | number | null): never => { throw new Error(`exit:${_code ?? 0}`); },
  );
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// ── gatewayConnect ────────────────────────────────────────────────────────────

describe('gatewayConnect', () => {
  it('success — calls printKeyValue twice (cert + policy)', async () => {
    mockApiClient.gatewayConnect.mockResolvedValue(MOCK_CONNECT_RESPONSE);
    await gatewayConnect(PROJECT_ID, CERT_ID);
    expect(mockPrintKeyValue).toHaveBeenCalledTimes(2);
  });

  it('success — first printKeyValue call contains certId and accessLevel', async () => {
    mockApiClient.gatewayConnect.mockResolvedValue(MOCK_CONNECT_RESPONSE);
    await gatewayConnect(PROJECT_ID, CERT_ID);
    const certBlock = mockPrintKeyValue.mock.calls[0][0];
    expect(certBlock['Cert ID']).toBe(CERT_ID);
    expect(certBlock['Access level']).toBe('READ_WRITE');
    expect(certBlock['Status']).toBe('connected');
  });

  it('success — second printKeyValue call contains policy fields', async () => {
    mockApiClient.gatewayConnect.mockResolvedValue(MOCK_CONNECT_RESPONSE);
    await gatewayConnect(PROJECT_ID, CERT_ID);
    const policyBlock = mockPrintKeyValue.mock.calls[1][0];
    expect(policyBlock['Requires mTLS']).toBe(true);
    expect(policyBlock['Allowed access']).toBe('READ_WRITE');
    expect(policyBlock).toHaveProperty('Row limit');
    expect(policyBlock).toHaveProperty('Max payload');
    expect(policyBlock).toHaveProperty('Query timeout');
  });

  it('success — no privateKeyPem or sslKey in any console output', async () => {
    mockApiClient.gatewayConnect.mockResolvedValue(MOCK_CONNECT_RESPONSE);
    await gatewayConnect(PROJECT_ID, CERT_ID);
    const allOut = [...logSpy.mock.calls.flat(), ...errSpy.mock.calls.flat()].join(' ');
    expect(allOut).not.toContain('privateKeyPem');
    expect(allOut).not.toContain('sslKey');
    expect(allOut).not.toContain('PRIVATE KEY');
  });

  it('403 expired — exits 1, prints expiry + certId + renew hint', async () => {
    mockApiClient.gatewayConnect.mockRejectedValue(axiosErr(403, 'Certificate has expired'));
    await expect(gatewayConnect(PROJECT_ID, CERT_ID)).rejects.toThrow('exit:1');
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('expired');
    expect(errOut).toContain(CERT_ID);
    expect(errOut).toContain('basefyio certs renew');
  });

  it('403 revoked (crl_revoked) — exits 1, prints revoked + issue hint', async () => {
    mockApiClient.gatewayConnect.mockRejectedValue(axiosErr(403, 'Certificate has been revoked'));
    await expect(gatewayConnect(PROJECT_ID, CERT_ID)).rejects.toThrow('exit:1');
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('revoked');
    expect(errOut).toContain('basefyio certs issue');
  });

  it('503 — exits 1, prints OpenBao unavailable message', async () => {
    mockApiClient.gatewayConnect.mockRejectedValue(
      axiosErr(503, 'Certificate authority is temporarily unavailable'),
    );
    await expect(gatewayConnect(PROJECT_ID, CERT_ID)).rejects.toThrow('exit:1');
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('OpenBao');
    expect(errOut).toContain('temporarily unavailable');
  });

  it('unrecognised error — delegates to handleApiError', async () => {
    const original = new Error('unexpected');
    mockApiClient.gatewayConnect.mockRejectedValue(original);
    await expect(gatewayConnect(PROJECT_ID, CERT_ID)).rejects.toBe(original);
  });
});

// ── gatewayQuery ──────────────────────────────────────────────────────────────

describe('gatewayQuery', () => {
  it('success — prints column headers and row values', async () => {
    mockApiClient.gatewayQuery.mockResolvedValue({
      rows: [{ id: 1, name: 'Alice' }],
      rowCount: 1,
    });
    await gatewayQuery(PROJECT_ID, CERT_ID, 'SELECT id, name FROM users');
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('id');
    expect(out).toContain('name');
    expect(out).toContain('Alice');
    expect(out).toContain('1 row(s)');
  });

  it('empty result — prints "No rows returned"', async () => {
    mockApiClient.gatewayQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await gatewayQuery(PROJECT_ID, CERT_ID, 'SELECT 1 WHERE false');
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toContain('No rows returned');
  });

  it('truncated result — prints truncation warning with counts', async () => {
    mockApiClient.gatewayQuery.mockResolvedValue({
      rows: Array.from({ length: 1000 }, (_, i) => ({ id: i })),
      rowCount: 5000,
      truncated: true,
    });
    await gatewayQuery(PROJECT_ID, CERT_ID, 'SELECT * FROM big');
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toContain('truncated');
    expect(out).toContain('1000');
    expect(out).toContain('5000');
  });

  it('multirow result — prints correct row count in footer', async () => {
    mockApiClient.gatewayQuery.mockResolvedValue({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      rowCount: 3,
    });
    await gatewayQuery(PROJECT_ID, CERT_ID, 'SELECT id FROM t');
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toContain('3 row(s)');
  });

  it('403 READ-only cert — exits 1, prints read-only hint', async () => {
    mockApiClient.gatewayQuery.mockRejectedValue(
      axiosErr(403, 'Certificate has READ-only access. Mutating queries are not permitted.'),
    );
    await expect(gatewayQuery(PROJECT_ID, CERT_ID, "INSERT INTO t VALUES (1)")).rejects.toThrow('exit:1');
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('READ-only');
    expect(errOut).toContain('basefyio certs issue --access-level READ_WRITE');
  });

  it('408 timeout — exits 1, prints timeout + LIMIT hint', async () => {
    mockApiClient.gatewayQuery.mockRejectedValue(
      axiosErr(408, 'Query exceeded the 30000ms timeout limit.'),
    );
    await expect(gatewayQuery(PROJECT_ID, CERT_ID, 'SELECT pg_sleep(60)')).rejects.toThrow('exit:1');
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('timed out');
    expect(errOut).toContain('LIMIT');
  });

  it('413 payload too large — exits 1, prints LIMIT hint', async () => {
    mockApiClient.gatewayQuery.mockRejectedValue(
      axiosErr(413, 'Query result size exceeds the maximum allowed'),
    );
    await expect(gatewayQuery(PROJECT_ID, CERT_ID, 'SELECT * FROM huge')).rejects.toThrow('exit:1');
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('too large');
    expect(errOut).toContain('LIMIT');
  });

  it('unrecognised error — delegates to handleApiError', async () => {
    const original = new Error('db crash');
    mockApiClient.gatewayQuery.mockRejectedValue(original);
    await expect(gatewayQuery(PROJECT_ID, CERT_ID, 'SELECT 1')).rejects.toBe(original);
  });
});

// ── gatewayPolicy ─────────────────────────────────────────────────────────────

describe('gatewayPolicy', () => {
  it('success — calls printKeyValue with all policy fields', async () => {
    mockApiClient.gatewayPolicy.mockResolvedValue(MOCK_POLICY);
    await gatewayPolicy(PROJECT_ID);
    expect(mockPrintKeyValue).toHaveBeenCalledTimes(1);
    const block = mockPrintKeyValue.mock.calls[0][0];
    expect(block['Requires mTLS']).toBe(true);
    expect(block['Allowed access']).toBe('READ_WRITE');
    expect(block).toHaveProperty('Max connections');
    expect(block).toHaveProperty('Row limit');
    expect(block).toHaveProperty('Max payload');
    expect(block).toHaveProperty('Provider');
  });

  it('success — prints project ID in header', async () => {
    mockApiClient.gatewayPolicy.mockResolvedValue(MOCK_POLICY);
    await gatewayPolicy(PROJECT_ID);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toContain(PROJECT_ID);
  });

  it('error — delegates to handleApiError', async () => {
    const original = new Error('unauthorized');
    mockApiClient.gatewayPolicy.mockRejectedValue(original);
    await expect(gatewayPolicy(PROJECT_ID)).rejects.toBe(original);
  });
});

// ── gatewayHealth ─────────────────────────────────────────────────────────────

const MOCK_HEALTH_REPORT = {
  status: 'healthy' as const,
  checkedAt: '2026-06-13T12:00:00.000Z',
  components: {
    system: { status: 'ok' },
    pkiMount: { status: 'ok' },
    kvMount: { status: 'ok' },
  },
};

describe('gatewayHealth', () => {
  it('success — prints OpenBao Health header and status', async () => {
    mockApiClient.gatewayHealth.mockResolvedValue(MOCK_HEALTH_REPORT);
    await gatewayHealth();
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toContain('OpenBao Health');
    expect(out).toContain('healthy');
    expect(out).toContain('2026-06-13T12:00:00.000Z');
  });

  it('success — prints all three component rows', async () => {
    mockApiClient.gatewayHealth.mockResolvedValue(MOCK_HEALTH_REPORT);
    await gatewayHealth();
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toContain('system');
    expect(out).toContain('pkiMount');
    expect(out).toContain('kvMount');
  });

  it('degraded — prints component detail and hint', async () => {
    mockApiClient.gatewayHealth.mockResolvedValue({
      status: 'degraded',
      checkedAt: '2026-06-13T12:00:00.000Z',
      components: {
        system: { status: 'ok' },
        pkiMount: { status: 'degraded', detail: 'not mounted', hint: 'vault secrets enable pki' },
        kvMount: { status: 'ok' },
      },
    });
    await gatewayHealth();
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toContain('degraded');
    expect(out).toContain('not mounted');
    expect(out).toContain('vault secrets enable pki');
  });

  it('unavailable — prints unavailable status', async () => {
    mockApiClient.gatewayHealth.mockResolvedValue({
      status: 'unavailable',
      checkedAt: '2026-06-13T12:00:00.000Z',
      components: {
        system: { status: 'unavailable', detail: 'unreachable', hint: 'check OpenBao is running' },
        pkiMount: { status: 'unavailable' },
        kvMount: { status: 'unavailable' },
      },
    });
    await gatewayHealth();
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toContain('unavailable');
  });

  it('security — CLI does not inject vault token or baseUrl into output', async () => {
    // The CLI has no access to vault credentials — it only formats the server's
    // OpenBaoHealthReport. The server-side invariant (no token in report) is
    // covered by openbao-health.service.spec.ts.
    // This test verifies the CLI formatter itself never produces vault-like strings.
    mockApiClient.gatewayHealth.mockResolvedValue(MOCK_HEALTH_REPORT);
    await gatewayHealth();
    const allOut = [...logSpy.mock.calls.flat(), ...errSpy.mock.calls.flat()].join(' ');
    expect(allOut).not.toMatch(/hvs\.[A-Za-z0-9]/); // Vault token pattern
    expect(allOut).not.toContain('vaultToken');
    expect(allOut).not.toContain('privateKeyPem');
  });

  it('503 — exits 1 with OpenBao unavailable message', async () => {
    mockApiClient.gatewayHealth.mockRejectedValue(
      axiosErr(503, 'OpenBao PKI temporarily unavailable'),
    );
    await expect(gatewayHealth()).rejects.toThrow('exit:1');
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('OpenBao');
    expect(errOut).toContain('temporarily unavailable');
  });

  it('network error — delegates to handleApiError', async () => {
    const original = new Error('ECONNREFUSED');
    mockApiClient.gatewayHealth.mockRejectedValue(original);
    await expect(gatewayHealth()).rejects.toBe(original);
  });
});
