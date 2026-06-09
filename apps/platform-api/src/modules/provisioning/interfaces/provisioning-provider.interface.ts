export const PROVISIONING_PROVIDER = 'PROVISIONING_PROVIDER';

export interface ProvisioningExecuteInput {
  operationId: string;
  type: string;
  input: unknown;
  /** OpenBao path reference only — never the credential bytes themselves. */
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
