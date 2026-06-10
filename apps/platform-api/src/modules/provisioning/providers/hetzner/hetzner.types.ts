/**
 * Hetzner provider types — Phase 9.
 *
 * Spec shapes use snake_case to match Hetzner API vocabulary and the DB-stored
 * desiredSpec/actualSpec fields. Client return types use camelCase (TypeScript
 * convention); the HTTP client layer is responsible for the mapping.
 */

// ── Desired spec shapes (stored in DB, written by callers) ──────

export interface HetznerServerSpec {
  server_type: string;    // e.g. 'cx11', 'cpx21', 'ccx13'
  image: string;          // e.g. 'ubuntu-22.04', 'debian-12'
  ssh_keys?: string[];    // SSH key names or IDs registered in Hetzner project
  labels?: Record<string, string>;
  user_data?: string;     // cloud-init script, base64 or raw
}

// ── API request params (sent to IHetznerClient) ──────────────────

export interface HetznerCreateServerParams {
  name: string;
  server_type: string;
  image: string;
  location: string;        // resolved Hetzner location code (nbg1, fsn1, hel1, ash, hil)
  ssh_keys?: string[];
  labels?: Record<string, string>;
  user_data?: string;
}

// ── Normalized API results (returned by IHetznerClient) ─────────

export interface HetznerCreatedServer {
  id: number;
  name: string;
  /** Hetzner provisioning status: 'initializing' | 'starting' | 'running' | 'off' */
  status: string;
  serverType: string;
  publicIpv4: string | null;
  locationName: string;   // e.g. 'nbg1'
  datacenterName: string; // e.g. 'nbg1-dc3'
}
