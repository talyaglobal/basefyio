/**
 * Resolve an env var by checking the BASEFYIO_* name first, then the
 * legacy KOLAYBASE_* name for backward compatibility with existing deployments.
 *
 * Usage:  resolveEnv('BASEFYIO_PROJECT_ID', 'KOLAYBASE_PROJECT_ID')
 *
 * CI gate: only this file (and the designated CLI fallback) may reference
 * KOLAYBASE_ env var names. All other code must use BASEFYIO_* only.
 */
export function resolveEnv(primary: string, legacy: string): string | undefined {
  try {
    const env = (globalThis as any).process?.env;
    return env?.[primary] ?? env?.[legacy] ?? undefined;
  } catch {
    return undefined;
  }
}
