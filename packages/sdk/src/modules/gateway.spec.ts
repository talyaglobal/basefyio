import { describe, it, expect, vi } from 'vitest';
import { GatewayClient } from './gateway.js';
import type { BasefyioFetchClient } from '../lib/fetch.js';

function makeHttp(response: any): BasefyioFetchClient {
  return { json: vi.fn().mockResolvedValue(response) } as any;
}

function makeHttpRejecting(error: any): BasefyioFetchClient {
  return { json: vi.fn().mockRejectedValue(error) } as any;
}

const PROJECT_ID = 'proj-gw-1';
const CERT_ID = 'cert-abc';

const SAMPLE_POLICY = {
  projectId: PROJECT_ID,
  requireMtls: true,
  allowedAccess: 'READ_WRITE' as const,
  maxConnections: 5,
  queryTimeoutMs: 30_000,
  maxRowLimit: 1_000,
  maxPayloadBytes: 5_242_880,
  providerType: 'postgres-jsonb' as const,
};

const SAMPLE_CONNECT_RESPONSE = {
  certId: CERT_ID,
  accessLevel: 'READ_WRITE' as const,
  policy: SAMPLE_POLICY,
  status: 'connected' as const,
};

const SAMPLE_QUERY_RESULT = {
  rows: [{ id: 1, name: 'Alice' }],
  rowCount: 1,
};

// ── connect() ────────────────────────────────────────────────────────────────

describe('GatewayClient.connect()', () => {
  it('POSTs to /v1/projects/:projectId/gateway/connect with certId body', async () => {
    const http = makeHttp(SAMPLE_CONNECT_RESPONSE);
    const client = new GatewayClient(http);

    const result = await client.connect(PROJECT_ID, CERT_ID);

    const [url, opts] = (http.json as any).mock.calls[0];
    expect(url).toBe(`/v1/projects/${PROJECT_ID}/gateway/connect`);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ certId: CERT_ID });
    expect(result.status).toBe('connected');
    expect(result.accessLevel).toBe('READ_WRITE');
  });

  it('URL-encodes projectId with spaces', async () => {
    const http = makeHttp(SAMPLE_CONNECT_RESPONSE);
    const client = new GatewayClient(http);

    await client.connect('my project', CERT_ID);

    const [url] = (http.json as any).mock.calls[0];
    expect(url).toContain('my%20project');
    expect(url).not.toContain('my project');
  });

  it('response never contains privateKeyPem or sslKey', async () => {
    const http = makeHttp(SAMPLE_CONNECT_RESPONSE);
    const client = new GatewayClient(http);

    const result = await client.connect(PROJECT_ID, CERT_ID);
    const json = JSON.stringify(result);

    expect(json).not.toContain('privateKeyPem');
    expect(json).not.toContain('sslKey');
  });

  it('403 → propagates error without swallowing', async () => {
    const err = { status: 403, message: 'Plan does not include feature: gatewayConnect' };
    const http = makeHttpRejecting(err);
    const client = new GatewayClient(http);

    await expect(client.connect(PROJECT_ID, CERT_ID)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('503 → propagates ServiceUnavailable for OpenBao outage', async () => {
    const err = { status: 503, message: 'Certificate authority is temporarily unavailable' };
    const http = makeHttpRejecting(err);
    const client = new GatewayClient(http);

    await expect(client.connect(PROJECT_ID, CERT_ID)).rejects.toMatchObject({ status: 503 });
  });

  it('response has policy with allowedAccess field', async () => {
    const http = makeHttp(SAMPLE_CONNECT_RESPONSE);
    const client = new GatewayClient(http);

    const result = await client.connect(PROJECT_ID, CERT_ID);
    expect(result.policy).toBeDefined();
    expect(['READ', 'READ_WRITE']).toContain(result.policy.allowedAccess);
    expect(typeof result.policy.maxRowLimit).toBe('number');
    expect(typeof result.policy.queryTimeoutMs).toBe('number');
  });
});

// ── query() ───────────────────────────────────────────────────────────────────

describe('GatewayClient.query()', () => {
  it('POSTs to /v1/projects/:projectId/gateway/query with certId + sql', async () => {
    const http = makeHttp(SAMPLE_QUERY_RESULT);
    const client = new GatewayClient(http);

    await client.query(PROJECT_ID, CERT_ID, 'SELECT id FROM items');

    const [url, opts] = (http.json as any).mock.calls[0];
    expect(url).toBe(`/v1/projects/${PROJECT_ID}/gateway/query`);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.certId).toBe(CERT_ID);
    expect(body.sql).toBe('SELECT id FROM items');
  });

  it('passes params array in request body', async () => {
    const http = makeHttp(SAMPLE_QUERY_RESULT);
    const client = new GatewayClient(http);

    await client.query(PROJECT_ID, CERT_ID, 'SELECT * FROM items WHERE id = $1', [42]);

    const [, opts] = (http.json as any).mock.calls[0];
    expect(JSON.parse(opts.body).params).toEqual([42]);
  });

  it('returns rows and rowCount from response', async () => {
    const http = makeHttp(SAMPLE_QUERY_RESULT);
    const client = new GatewayClient(http);

    const result = await client.query(PROJECT_ID, CERT_ID, 'SELECT 1');
    expect(result.rows).toHaveLength(1);
    expect(result.rowCount).toBe(1);
  });

  it('propagates truncated flag when server caps rows', async () => {
    const truncated = { ...SAMPLE_QUERY_RESULT, truncated: true, rowCount: 5000 };
    const http = makeHttp(truncated);
    const client = new GatewayClient(http);

    const result = await client.query(PROJECT_ID, CERT_ID, 'SELECT * FROM huge_table');
    expect(result.truncated).toBe(true);
  });

  it('403 for READ-only cert attempting INSERT', async () => {
    const err = { status: 403, message: 'Certificate has READ-only access' };
    const http = makeHttpRejecting(err);
    const client = new GatewayClient(http);

    await expect(
      client.query(PROJECT_ID, CERT_ID, "INSERT INTO items VALUES ('x')"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('408 for query timeout', async () => {
    const err = { status: 408, message: 'Query exceeded the 30000ms timeout limit.' };
    const http = makeHttpRejecting(err);
    const client = new GatewayClient(http);

    await expect(client.query(PROJECT_ID, CERT_ID, 'SELECT pg_sleep(60)')).rejects.toMatchObject({ status: 408 });
  });
});

// ── getPolicy() ───────────────────────────────────────────────────────────────

describe('GatewayClient.getPolicy()', () => {
  it('GETs /v1/projects/:projectId/gateway/policy', async () => {
    const http = makeHttp(SAMPLE_POLICY);
    const client = new GatewayClient(http);

    const result = await client.getPolicy(PROJECT_ID);

    const [url, opts] = (http.json as any).mock.calls[0];
    expect(url).toBe(`/v1/projects/${PROJECT_ID}/gateway/policy`);
    expect(opts ?? {}).not.toHaveProperty('method', 'POST');
    expect(result.requireMtls).toBe(true);
  });

  it('response has all required policy fields', async () => {
    const http = makeHttp(SAMPLE_POLICY);
    const client = new GatewayClient(http);

    const p = await client.getPolicy(PROJECT_ID);
    expect(p).toHaveProperty('allowedAccess');
    expect(p).toHaveProperty('maxConnections');
    expect(p).toHaveProperty('queryTimeoutMs');
    expect(p).toHaveProperty('maxRowLimit');
    expect(p).toHaveProperty('maxPayloadBytes');
    expect(p).toHaveProperty('providerType');
  });
});

// ── health() ──────────────────────────────────────────────────────────────────

const HEALTHY_REPORT = {
  status: 'healthy' as const,
  checkedAt: '2026-06-13T12:00:00.000Z',
  components: {
    system: { status: 'ok' as const },
    pkiMount: { status: 'ok' as const },
    kvMount: { status: 'ok' as const },
  },
};

const DEGRADED_REPORT = {
  status: 'degraded' as const,
  checkedAt: '2026-06-13T12:00:00.000Z',
  components: {
    system: { status: 'ok' as const },
    pkiMount: {
      status: 'degraded' as const,
      detail: "PKI mount 'pki' not found or CA not configured",
      hint: 'vault secrets enable -path=pki pki',
    },
    kvMount: { status: 'ok' as const },
  },
};

describe('GatewayClient.health()', () => {
  it('GETs /v1/secure-gateway/health/openbao', async () => {
    const http = makeHttp(HEALTHY_REPORT);
    const client = new GatewayClient(http);

    await client.health();

    const [url] = (http.json as any).mock.calls[0];
    expect(url).toBe('/v1/secure-gateway/health/openbao');
  });

  it('returns healthy report with all component statuses', async () => {
    const http = makeHttp(HEALTHY_REPORT);
    const client = new GatewayClient(http);

    const result = await client.health();
    expect(result.status).toBe('healthy');
    expect(result.components.system.status).toBe('ok');
    expect(result.components.pkiMount.status).toBe('ok');
    expect(result.components.kvMount.status).toBe('ok');
    expect(result.checkedAt).toBeDefined();
  });

  it('passes degraded report through with hints', async () => {
    const http = makeHttp(DEGRADED_REPORT);
    const client = new GatewayClient(http);

    const result = await client.health();
    expect(result.status).toBe('degraded');
    expect(result.components.pkiMount.status).toBe('degraded');
    expect(result.components.pkiMount.hint).toMatch(/vault secrets enable/i);
  });

  it('propagates errors from the API', async () => {
    const err = { status: 401, message: 'Unauthorized' };
    const http = makeHttpRejecting(err);
    const client = new GatewayClient(http);

    await expect(client.health()).rejects.toMatchObject({ status: 401 });
  });

  it('response never contains a vault token', async () => {
    const http = makeHttp(HEALTHY_REPORT);
    const client = new GatewayClient(http);

    const result = await client.health();
    expect(JSON.stringify(result)).not.toMatch(/token|secret|Bearer/i);
  });
});
