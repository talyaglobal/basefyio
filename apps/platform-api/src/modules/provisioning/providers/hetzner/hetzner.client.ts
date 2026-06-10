import { Injectable } from '@nestjs/common';
import { IHetznerClient } from './hetzner-client.interface';
import { HetznerCreateServerParams, HetznerCreatedServer } from './hetzner.types';

const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

/**
 * HTTP error from the Hetzner Cloud API.
 * The `code` and `retryable` fields satisfy the normalizeProviderError contract.
 */
export class HetznerApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HetznerApiError';
  }
}

/**
 * Stateless Hetzner Cloud API client.
 *
 * Each method receives the resolved API token as a call-site parameter.
 * The client holds no credential state — the token is never stored on the instance.
 *
 * Token safety: no error path includes the raw token or raw response bodies.
 * Only Hetzner `error.code` values appear in error messages.
 *
 * Retry policy: 429 and 5xx are retryable (max 3 attempts, exponential back-off
 * starting at 1 s). 4xx (non-429) and network errors after max retries propagate
 * as HetznerApiError with retryable=false or retryable=true respectively.
 */
@Injectable()
export class HetznerClient implements IHetznerClient {
  async createServer(
    params: HetznerCreateServerParams,
    apiToken: string,
  ): Promise<HetznerCreatedServer> {
    const body = await this.postWithRetry('/servers', params, apiToken) as Record<string, unknown>;
    return mapCreatedServer(body['server'] as Record<string, unknown>);
  }

  async getServer(serverId: number, apiToken: string): Promise<HetznerCreatedServer> {
    const body = await this.requestWithRetry('GET', `/servers/${serverId}`, null, apiToken) as Record<string, unknown>;
    return mapCreatedServer(body['server'] as Record<string, unknown>);
  }

  async deleteServer(serverId: number, apiToken: string): Promise<void> {
    await this.requestWithRetry('DELETE', `/servers/${serverId}`, null, apiToken);
  }

  async rebuildServer(serverId: number, imageSlug: string, apiToken: string): Promise<void> {
    await this.postWithRetry(
      `/servers/${serverId}/actions/rebuild`,
      { image: imageSlug },
      apiToken,
    );
  }

  async resizeServer(serverId: number, serverType: string, apiToken: string): Promise<void> {
    await this.postWithRetry(
      `/servers/${serverId}/actions/change_type`,
      { server_type: serverType, upgrade_disk: false },
      apiToken,
    );
  }

  // ── Retry loop ────────────────────────────────────────────────

  private async postWithRetry(path: string, body: unknown, apiToken: string): Promise<unknown> {
    return this.requestWithRetry('POST', path, body, apiToken);
  }

  private async requestWithRetry(
    method: string,
    path: string,
    body: unknown,
    apiToken: string,
  ): Promise<unknown> {
    let lastError: HetznerApiError | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
      try {
        return await this.request(method, path, body, apiToken);
      } catch (err) {
        if (!(err instanceof HetznerApiError) || !err.retryable) throw err;
        lastError = err;
      }
    }
    throw lastError!;
  }

  // ── Single HTTP request ───────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body: unknown,
    apiToken: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${HETZNER_API_BASE}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch {
      // Network error — URL and token intentionally omitted from message.
      throw new HetznerApiError(
        'Hetzner API: network error (could not connect)',
        0,
        'NETWORK_ERROR',
        true,
      );
    }

    if (response.status === 429) {
      throw new HetznerApiError(
        'Hetzner API: rate limit exceeded (HTTP 429)',
        429,
        'rate_limit_exceeded',
        true,
      );
    }

    if (response.status >= 500) {
      throw new HetznerApiError(
        `Hetzner API: server error (HTTP ${response.status})`,
        response.status,
        'server_error',
        true,
      );
    }

    if (response.status === 204) return null;

    if (!response.ok) {
      // Extract only the Hetzner error.code (a safe enum value).
      // Never propagate the full error.message — it may contain context we shouldn't expose.
      let errorCode = 'unknown_error';
      try {
        const json = (await response.json()) as { error?: { code?: string } };
        errorCode = json?.error?.code ?? 'unknown_error';
      } catch {
        // JSON parse failed — keep 'unknown_error'
      }
      throw new HetznerApiError(
        `Hetzner API: ${errorCode} (HTTP ${response.status})`,
        response.status,
        errorCode,
        false,
      );
    }

    return response.json() as Promise<unknown>;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ── Response mapper ───────────────────────────────────────────

function mapCreatedServer(raw: Record<string, unknown>): HetznerCreatedServer {
  const net = raw['public_net'] as Record<string, unknown> | undefined;
  const ipv4 = net?.['ipv4'] as Record<string, unknown> | undefined;
  const serverType = raw['server_type'] as Record<string, unknown> | undefined;
  const datacenter = raw['datacenter'] as Record<string, unknown> | undefined;
  const location = datacenter?.['location'] as Record<string, unknown> | undefined;

  return {
    id: raw['id'] as number,
    name: raw['name'] as string,
    status: raw['status'] as string,
    serverType: (serverType?.['name'] as string) ?? '',
    publicIpv4: (ipv4?.['ip'] as string) ?? null,
    locationName: (location?.['name'] as string) ?? '',
    datacenterName: (datacenter?.['name'] as string) ?? '',
  };
}
