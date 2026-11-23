/** Browser fetch() failures are bare TypeErrors with engine-specific text. */
const NETWORK_MESSAGES = /^(failed to fetch|load failed|networkerror when attempting to fetch resource\.?|network request failed)$/i;

export const NETWORK_ERROR_MESSAGE = "Can't reach the server. Check your connection and try again.";

export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError && NETWORK_MESSAGES.test(err.message.trim());
}

/** Turns "Failed to fetch" into a sentence a person can act on; other errors pass through. */
export function friendlyError(err: unknown, fallback = 'Something went wrong'): string {
  if (isNetworkError(err)) return NETWORK_ERROR_MESSAGE;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
