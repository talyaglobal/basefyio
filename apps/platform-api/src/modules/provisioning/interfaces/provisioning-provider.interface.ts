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

export interface ProvisioningExecuteResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface IProvisioningProvider {
  execute(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult>;
}
