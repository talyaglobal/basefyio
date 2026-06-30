import {
  HetznerCreateServerParams,
  HetznerCreatedServer,
} from './hetzner.types';

export const HETZNER_CLIENT = 'HETZNER_CLIENT';

/**
 * Hetzner Cloud API client boundary.
 *
 * All methods receive a resolved API token so the client is stateless and injectable
 * as a singleton. The token is resolved from OpenBao by the provider — the client
 * never holds credential state.
 *
 * Phase 9: server operations only. Volume/network/firewall methods will be added
 * as SUPPORTED_KINDS expands.
 */
export interface IHetznerClient {
  // ── Server ───────────────────────────────────────────────────
  createServer(params: HetznerCreateServerParams, apiToken: string): Promise<HetznerCreatedServer>;
  /** Fetch current server state. Used for read-after-write after UPDATE actions. */
  getServer(serverId: number, apiToken: string): Promise<HetznerCreatedServer>;
  deleteServer(serverId: number, apiToken: string): Promise<void>;
  /** Reinstall a server from a different image. Server is stopped during rebuild. */
  rebuildServer(serverId: number, imageSlug: string, apiToken: string): Promise<void>;
  /** Change server type (resize). Server must be off; Hetzner handles the migration. */
  resizeServer(serverId: number, serverType: string, apiToken: string): Promise<void>;
}
