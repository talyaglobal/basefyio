export const HETZNER_TOKEN_RESOLVER = 'HETZNER_TOKEN_RESOLVER';

/**
 * Resolves a Hetzner API token from an OpenBao/Vault path.
 *
 * Contract:
 * - The resolved token lives only inside the provider's apply() call.
 * - It must never appear in logs, audit events, operation results, or error payloads.
 * - Implementations must sanitize errors so raw vault responses are not propagated.
 */
export interface IHetznerTokenResolver {
  resolve(openbaoPath: string): Promise<string>;
}
