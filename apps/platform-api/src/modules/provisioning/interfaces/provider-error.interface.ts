export interface NormalizedProviderError {
  /** Short machine-readable code for the failure category. */
  code: string;
  message: string;
  /** Whether the operation is safe to retry without side effects. */
  retryable: boolean;
  detail?: unknown;
}

export function normalizeProviderError(err: unknown): NormalizedProviderError {
  if (err != null && typeof err === 'object' && 'code' in err && 'retryable' in err) {
    return err as NormalizedProviderError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'PROVIDER_ERROR', message, retryable: false };
}
