/**
 * Whether this process has been told to stop.
 *
 * Set the moment SIGTERM or SIGINT arrives, before Nest starts closing
 * anything, so the readiness route can answer 503 at once and the proxy stops
 * sending new requests here while the ones already in flight finish. A plain
 * module-level flag rather than a provider: it must be readable from the
 * signal handler in `main.ts`, which runs outside the injector.
 */
let draining = false;
let since: Date | null = null;

export const drainState = {
  start(): void {
    if (draining) return;
    draining = true;
    since = new Date();
  },
  isDraining(): boolean {
    return draining;
  },
  since(): Date | null {
    return since;
  },
  /** Tests only. */
  reset(): void {
    draining = false;
    since = null;
  },
};
