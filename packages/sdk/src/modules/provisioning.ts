import type { BasefyioFetchClient } from '../lib/fetch.js';
import type {
  BasefyioResponse,
  ProvisioningProjectCreateInput,
  ProvisioningProjectCreateResult,
  ProvisioningProjectStatus,
  ProvisioningOperationCreateInput,
  ProvisioningOperation,
  ProvisioningListOperationsOptions,
  ProvisioningResource,
  ProvisioningCredentialRef,
  ProvisioningCredentialRefCreateInput,
  ProvisioningWaitOptions,
  ProvisioningAuditEvent,
} from '../lib/types.js';

const BASE = '/v1/provisioning';

export class ProvisioningClient {
  private http: BasefyioFetchClient;

  constructor(http: BasefyioFetchClient) {
    this.http = http;
  }

  // ── Projects ──────────────────────────────────────────────

  async createProject(
    input: ProvisioningProjectCreateInput,
  ): Promise<BasefyioResponse<ProvisioningProjectCreateResult>> {
    try {
      const data = await this.http.json<ProvisioningProjectCreateResult>(
        `${BASE}/projects`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async getProject(projectId: string): Promise<BasefyioResponse<ProvisioningProjectStatus>> {
    try {
      const data = await this.http.json<ProvisioningProjectStatus>(
        `${BASE}/projects?projectId=${encodeURIComponent(projectId)}`,
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  // ── Operations ────────────────────────────────────────────

  async createOperation(
    input: ProvisioningOperationCreateInput,
  ): Promise<BasefyioResponse<ProvisioningOperation>> {
    try {
      const data = await this.http.json<ProvisioningOperation>(
        `${BASE}/operations`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async listOperations(
    opts: ProvisioningListOperationsOptions,
  ): Promise<BasefyioResponse<ProvisioningOperation[]>> {
    try {
      const params = new URLSearchParams({ projectId: opts.projectId });
      if (opts.status) params.set('status', opts.status);
      if (opts.limit != null) params.set('limit', String(opts.limit));
      const data = await this.http.json<ProvisioningOperation[]>(
        `${BASE}/operations?${params}`,
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async getOperation(operationId: string): Promise<BasefyioResponse<ProvisioningOperation>> {
    try {
      const data = await this.http.json<ProvisioningOperation>(
        `${BASE}/operations/${encodeURIComponent(operationId)}`,
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async cancelOperation(operationId: string): Promise<BasefyioResponse<ProvisioningOperation>> {
    try {
      const data = await this.http.json<ProvisioningOperation>(
        `${BASE}/operations/${encodeURIComponent(operationId)}/cancel`,
        { method: 'POST' },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async executeOperation(operationId: string): Promise<BasefyioResponse<ProvisioningOperation>> {
    try {
      const data = await this.http.json<ProvisioningOperation>(
        `${BASE}/operations/${encodeURIComponent(operationId)}/execute`,
        { method: 'POST' },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async waitForCompletion(
    operationId: string,
    opts: ProvisioningWaitOptions = {},
  ): Promise<BasefyioResponse<ProvisioningOperation>> {
    const interval = opts.pollingIntervalMs ?? 2000;
    const timeout  = opts.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeout;

    const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL_FAILED']);

    while (true) {
      const res = await this.getOperation(operationId);
      if (res.error) return res;
      if (TERMINAL.has(res.data!.status as string)) return res;
      if (Date.now() >= deadline) {
        return { data: null, error: { message: `Timed out waiting for operation ${operationId} after ${timeout}ms`, status: 408 } };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
  }

  async getOperationEvents(
    operationId: string,
  ): Promise<BasefyioResponse<ProvisioningAuditEvent[]>> {
    try {
      const data = await this.http.json<ProvisioningAuditEvent[]>(
        `${BASE}/operations/${encodeURIComponent(operationId)}/events`,
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  // ── Resources ─────────────────────────────────────────────

  async listResources(
    projectId: string,
    options: { includeDestroyed?: boolean } = {},
  ): Promise<BasefyioResponse<ProvisioningResource[]>> {
    try {
      const params = new URLSearchParams({ projectId });
      if (options.includeDestroyed) params.set('includeDestroyed', 'true');
      const data = await this.http.json<ProvisioningResource[]>(
        `${BASE}/resources?${params}`,
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  // ── Credential refs ───────────────────────────────────────

  async createCredentialRef(
    input: ProvisioningCredentialRefCreateInput,
  ): Promise<BasefyioResponse<ProvisioningCredentialRef>> {
    try {
      const data = await this.http.json<ProvisioningCredentialRef>(
        `${BASE}/credentials`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async listCredentialRefs(
    teamId: string,
  ): Promise<BasefyioResponse<ProvisioningCredentialRef[]>> {
    try {
      const data = await this.http.json<ProvisioningCredentialRef[]>(
        `${BASE}/credentials?teamId=${encodeURIComponent(teamId)}`,
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async revokeCredentialRef(credentialRefId: string): Promise<BasefyioResponse<null>> {
    try {
      await this.http.request<null>(
        `${BASE}/credentials/${encodeURIComponent(credentialRefId)}`,
        { method: 'DELETE' },
      );
      return { data: null, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }
}
