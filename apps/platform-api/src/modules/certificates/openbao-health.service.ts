import { Inject, Injectable, Logger } from '@nestjs/common';
import { OPENBAO_PKI_CONFIG, OpenBaoPkiConfig } from './providers/openbao-pki.provider';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComponentStatus = 'ok' | 'degraded' | 'unavailable';
export type OverallStatus = 'healthy' | 'degraded' | 'unavailable';

export interface OpenBaoComponentHealth {
  status: ComponentStatus;
  /** Human-readable detail. Never contains vault token, base URL, or credentials. */
  detail?: string;
  /** Operator hint for degraded/unavailable states. */
  hint?: string;
}

export interface OpenBaoHealthReport {
  status: OverallStatus;
  /** ISO-8601 timestamp */
  checkedAt: string;
  components: {
    system: OpenBaoComponentHealth;
    pkiMount: OpenBaoComponentHealth;
    kvMount: OpenBaoComponentHealth;
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Read-only OpenBao health observer.
 * No mutations, no key access, no bundle reads.
 *
 * Security rules:
 *  - vault token never appears in returned data, logs, or thrown errors.
 *  - base URL (internal hostname) never returned to API callers.
 *  - Every check is independently fail-open — one unavailable component
 *    does not prevent the other two from reporting.
 */
@Injectable()
export class OpenBaoHealthService {
  private readonly logger = new Logger(OpenBaoHealthService.name);

  constructor(@Inject(OPENBAO_PKI_CONFIG) private readonly cfg: OpenBaoPkiConfig) {}

  async check(): Promise<OpenBaoHealthReport> {
    const [system, pkiMount, kvMount] = await Promise.all([
      this.checkSystem(),
      this.checkPkiMount(),
      this.checkKvMount(),
    ]);

    const statuses: ComponentStatus[] = [system.status, pkiMount.status, kvMount.status];
    const overall: OverallStatus = statuses.every((s) => s === 'ok')
      ? 'healthy'
      : statuses.some((s) => s === 'unavailable')
      ? 'unavailable'
      : 'degraded';

    return {
      status: overall,
      checkedAt: new Date().toISOString(),
      components: { system, pkiMount, kvMount },
    };
  }

  // ── Component checks ────────────────────────────────────────────────────────

  private async checkSystem(): Promise<OpenBaoComponentHealth> {
    try {
      // /v1/sys/health is unauthenticated — HTTP status encodes the state.
      const res = await fetch(`${this.cfg.baseUrl}/v1/sys/health`, { method: 'GET' });

      if (res.status === 200) return { status: 'ok' };

      if (res.status === 429) {
        return {
          status: 'degraded',
          detail: 'OpenBao is in standby mode',
          hint: 'Requests are being forwarded to the active node. Writes may be slow.',
        };
      }
      if (res.status === 503) {
        return {
          status: 'unavailable',
          detail: 'OpenBao is sealed',
          hint: 'Run `vault operator unseal` on each node to restore availability.',
        };
      }
      if (res.status === 501) {
        return {
          status: 'unavailable',
          detail: 'OpenBao is not initialized',
          hint: 'Run `vault operator init` to initialize the cluster.',
        };
      }
      return {
        status: 'degraded',
        detail: `Unexpected system health status ${res.status}`,
      };
    } catch {
      return {
        status: 'unavailable',
        detail: 'OpenBao is unreachable',
        hint: 'Check network connectivity to the OpenBao address and firewall rules.',
      };
    }
  }

  private async checkPkiMount(): Promise<OpenBaoComponentHealth> {
    try {
      // GET /v1/{pkiMount}/ca/pem is a public endpoint that proves the PKI mount
      // is enabled and has a CA configured, without requiring special permissions.
      const res = await fetch(`${this.cfg.baseUrl}/v1/${this.cfg.pkiMount}/ca/pem`, {
        method: 'GET',
        headers: { 'X-Vault-Token': this.cfg.vaultToken },
      });

      if (res.status === 200) return { status: 'ok' };

      if (res.status === 404) {
        return {
          status: 'degraded',
          detail: `PKI mount '${this.cfg.pkiMount}' not found or CA not configured`,
          hint: `Enable the PKI secrets engine: vault secrets enable -path=${this.cfg.pkiMount} pki`,
        };
      }
      if (res.status === 403) {
        return {
          status: 'degraded',
          detail: 'PKI mount access denied',
          hint: 'Verify the vault token has read permissions on the PKI mount.',
        };
      }
      return {
        status: 'degraded',
        detail: `PKI mount returned unexpected status ${res.status}`,
      };
    } catch {
      return {
        status: 'unavailable',
        detail: 'PKI mount unreachable',
        hint: 'OpenBao system may be down — check the system component.',
      };
    }
  }

  private async checkKvMount(): Promise<OpenBaoComponentHealth> {
    try {
      // GET /v1/{kvMount}/config is the KV v2 tune config endpoint.
      // Returns 200 if the KV mount is active and the token has access.
      const res = await fetch(`${this.cfg.baseUrl}/v1/${this.cfg.kvMount}/config`, {
        method: 'GET',
        headers: { 'X-Vault-Token': this.cfg.vaultToken },
      });

      if (res.status === 200) return { status: 'ok' };

      if (res.status === 404) {
        return {
          status: 'degraded',
          detail: `KV mount '${this.cfg.kvMount}' not found`,
          hint: `Enable the KV secrets engine: vault secrets enable -path=${this.cfg.kvMount} -version=2 kv`,
        };
      }
      if (res.status === 403) {
        return {
          status: 'degraded',
          detail: 'KV mount access denied',
          hint: 'Verify the vault token has read permissions on the KV mount.',
        };
      }
      return {
        status: 'degraded',
        detail: `KV mount returned unexpected status ${res.status}`,
      };
    } catch {
      return {
        status: 'unavailable',
        detail: 'KV mount unreachable',
        hint: 'OpenBao system may be down — check the system component.',
      };
    }
  }
}
