import { Inject, Injectable } from '@nestjs/common';
import { IHetznerTokenResolver } from '../interfaces/hetzner-token-resolver.interface';

export const OPENBAO_CONFIG = 'OPENBAO_CONFIG';

export interface OpenBaoConfig {
  /** OpenBao base URL, e.g. https://vault.internal:8200 */
  baseUrl: string;
  /** Root/service vault token for authenticating with OpenBao. */
  vaultToken: string;
}

/**
 * Resolves Hetzner API tokens from OpenBao (Vault-compatible).
 *
 * Secret boundary rules enforced here:
 * - vaultToken and resolved Hetzner token are never included in thrown errors.
 * - Raw response bodies are never propagated — only sanitized status strings.
 * - Supports both KV v1 (data.token) and KV v2 (data.data.token) response shapes.
 */
@Injectable()
export class OpenBaoHetznerTokenResolver implements IHetznerTokenResolver {
  constructor(@Inject(OPENBAO_CONFIG) private readonly config: OpenBaoConfig) {}

  async resolve(openbaoPath: string): Promise<string> {
    if (!openbaoPath || openbaoPath.trim() === '') {
      throw new Error('HetznerTokenResolver: openbaoPath must not be empty');
    }

    const url = `${this.config.baseUrl}/v1/${openbaoPath.replace(/^\/+/, '')}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'X-Vault-Token': this.config.vaultToken,
          'Content-Type': 'application/json',
        },
      });
    } catch {
      // Network error — do NOT include url or token in message
      throw new Error('HetznerTokenResolver: could not reach OpenBao (network error)');
    }

    if (!response.ok) {
      // Status code is safe; body is not — never call response.text() here
      throw new Error(`HetznerTokenResolver: OpenBao returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('HetznerTokenResolver: OpenBao response was not valid JSON');
    }

    // KV v1: { data: { token: "..." } }
    // KV v2: { data: { data: { token: "..." } } }
    const token =
      (body as any)?.data?.token ??
      (body as any)?.data?.data?.token;

    if (typeof token !== 'string' || token.trim() === '') {
      throw new Error('HetznerTokenResolver: OpenBao response did not contain a valid token field');
    }

    return token;
  }
}
