import { ProvisioningResourceResult } from './provisioning-provider.interface';

/** One action that failed during a partial apply. */
export interface FailedActionRecord {
  resourceType: string;
  resourceName: string;
  action: string;
  error: string;
}

/**
 * Thrown by a provider's apply() when the action dispatch loop encounters at
 * least one error but also completes at least one action (partial success).
 *
 * The executor inspects appliedResources.length to distinguish:
 *   - length > 0  →  PARTIAL_FAILED  (run projection for the applied subset)
 *   - length = 0  →  FAILED          (no mutations occurred; treat as total failure)
 *
 * code/retryable satisfy the normalizeProviderError duck-type contract so this
 * error passes through correctly if it ever escapes the executor's specific catch.
 */
export class PartialApplyError extends Error {
  readonly code = 'PARTIAL_APPLY';
  readonly retryable = false;

  constructor(
    public readonly appliedResources: ProvisioningResourceResult[],
    public readonly deletedExternalIds: string[],
    public readonly failures: FailedActionRecord[],
  ) {
    const summary = `${appliedResources.length} applied, ${failures.length} failed`;
    super(`Partial apply: ${summary}`);
    this.name = 'PartialApplyError';
  }
}
