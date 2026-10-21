/** Small helpers for the BACKUP_* / BRANCH_* environment knobs. */

/** A positive integer from the environment, or the default when unset or invalid. */
export function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A boolean flag: "false"/"0"/"no"/"off" turn it off, "true"/"1"/"yes"/"on" turn it on, anything else keeps the default. */
export function envFlag(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  return fallback;
}

/** Comma-separated list from the environment, trimmed, empties dropped. */
export function envList(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
