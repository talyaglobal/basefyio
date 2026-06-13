import type { BasefyioFetchClient } from '../lib/fetch.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GatewayConnectionPolicy {
  projectId: string;
  requireMtls: boolean;
  allowedAccess: 'READ' | 'READ_WRITE';
  maxConnections: number;
  queryTimeoutMs: number;
  maxRowLimit: number;
  maxPayloadBytes: number;
  providerType: 'postgres-jsonb' | 'secure-postgres' | 'secure-mongo';
}

/** Returned by connect() — never contains private key material */
export interface GatewayConnectResponse {
  certId: string;
  accessLevel: 'READ' | 'READ_WRITE';
  policy: GatewayConnectionPolicy;
  status: 'connected';
}

export interface GatewayQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the result was truncated to the server-side row limit */
  truncated?: boolean;
}

export type OpenBaoComponentStatus = 'ok' | 'degraded' | 'unavailable';
export type OpenBaoOverallStatus = 'healthy' | 'degraded' | 'unavailable';

export interface OpenBaoComponentHealth {
  status: OpenBaoComponentStatus;
  detail?: string;
  hint?: string;
}

export interface OpenBaoHealthReport {
  status: OpenBaoOverallStatus;
  checkedAt: string;
  components: {
    system: OpenBaoComponentHealth;
    pkiMount: OpenBaoComponentHealth;
    kvMount: OpenBaoComponentHealth;
  };
}

// ── Client ────────────────────────────────────────────────────────────────────

export class GatewayClient {
  constructor(private readonly http: BasefyioFetchClient) {}

  /**
   * Validates the certificate against OpenBao and returns the connection policy.
   * The response never contains private key material — keys are resolved server-side.
   */
  async connect(projectId: string, certId: string): Promise<GatewayConnectResponse> {
    return this.http.json<GatewayConnectResponse>(
      `/v1/projects/${encodeURIComponent(projectId)}/gateway/connect`,
      { method: 'POST', body: JSON.stringify({ certId }) },
    );
  }

  /**
   * Executes a query through the secure gateway with policy enforcement.
   * Requires the GATEWAY_QUERY entitlement on the project's plan.
   */
  async query(
    projectId: string,
    certId: string,
    sql: string,
    params?: unknown[],
  ): Promise<GatewayQueryResult> {
    return this.http.json<GatewayQueryResult>(
      `/v1/projects/${encodeURIComponent(projectId)}/gateway/query`,
      { method: 'POST', body: JSON.stringify({ certId, sql, params }) },
    );
  }

  /** Returns the default connection policy for the project (no cert required). */
  async getPolicy(projectId: string): Promise<GatewayConnectionPolicy> {
    return this.http.json<GatewayConnectionPolicy>(
      `/v1/projects/${encodeURIComponent(projectId)}/gateway/policy`,
    );
  }

  /**
   * Returns the current OpenBao health status (system, PKI mount, KV mount).
   * Read-only — no mutations, no key access.
   */
  async health(): Promise<OpenBaoHealthReport> {
    return this.http.json<OpenBaoHealthReport>('/v1/secure-gateway/health/openbao');
  }
}
