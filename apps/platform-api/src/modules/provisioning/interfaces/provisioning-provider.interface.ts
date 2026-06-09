export const PROVISIONING_PROVIDER = 'PROVISIONING_PROVIDER';

export interface ProvisioningExecuteInput {
  operationId: string;
  projectId: string;
  providerType: string;
  region: string;
  datacenter: string | null;
  /** The operation's input payload (desired resource spec). */
  desiredSpec: unknown;
  /** OpenBao path reference only — the provider resolves the actual secret; the executor never does. */
  credentialOpenbaoPath: string;
}

/**
 * Domain shape for a single resource reported by the provider.
 * Maps to ProvisioningResource rows via the projection layer —
 * never stored directly as a DB row.
 */
export interface ProvisioningResourceResult {
  /** Provider-assigned identifier for the resource. */
  externalId: string;
  /** Matches a ProvisioningResourceKind value (case-insensitive). */
  type: string;
  name: string;
  desiredSpec: Record<string, unknown>;
  actualSpec: Record<string, unknown>;
  /** Only ACTIVE is valid for a successful execution result. */
  status: 'ACTIVE';
}

export interface ProvisioningExecuteResult {
  success: boolean;
  resources: ProvisioningResourceResult[];
  metadata?: Record<string, unknown>;
}

export interface IProvisioningProvider {
  execute(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult>;
}
