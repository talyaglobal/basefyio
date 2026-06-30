export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorEnv {
  /** e.g. "v20.11.0" */
  nodeVersion: string;
  /** whether a `docker` binary is on PATH */
  hasDocker: boolean;
  /** optional platform-api URL to probe */
  apiUrl?: string;
  /** result of probing apiUrl; null/undefined when not probed */
  apiReachable?: boolean | null;
}

export function checkNodeVersion(version: string): Check {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  const ok = Number.isFinite(major) && major >= 20;
  return {
    name: 'Node.js >= 20',
    ok,
    detail: ok ? `found ${version}` : `found ${version}, need >= 20`,
  };
}

/** Build the list of checks from a fully-resolved environment (pure + testable). */
export function runDoctor(env: DoctorEnv): Check[] {
  const checks: Check[] = [checkNodeVersion(env.nodeVersion)];

  checks.push({
    name: 'Docker available',
    ok: env.hasDocker,
    detail: env.hasDocker ? 'docker found on PATH' : 'docker not found on PATH',
  });

  if (env.apiUrl) {
    const ok = env.apiReachable === true;
    checks.push({
      name: `Platform API reachable (${env.apiUrl})`,
      ok,
      detail: ok ? 'responded to /health' : 'no healthy response',
    });
  }

  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${c.ok ? '[ok]' : '[!!]'} ${c.name} — ${c.detail}`)
    .join('\n');
}

export function allPassed(checks: Check[]): boolean {
  return checks.every((c) => c.ok);
}
