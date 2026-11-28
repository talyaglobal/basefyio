import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * scripts/migrate.mjs runs before the API in the container. A new pod can start a moment
 * before its network path to Postgres exists; the script must retry a refused connection
 * instead of crashing the container, and must still fail (non-zero) when the database
 * stays unreachable.
 */
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'migrate.mjs');
// Port 1 on loopback: nothing listens there, so the connection is refused at once.
const REFUSED = 'postgresql://u:p@127.0.0.1:1/db';

function run(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: REFUSED, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('migrate.mjs connection retry', () => {
  it('retries a refused connection, then fails with a non-zero exit when the budget runs out', () => {
    const { code, out } = run({ MIGRATE_CONNECT_TIMEOUT_MS: '1800' });
    expect(out).toContain('database not reachable yet (ECONNREFUSED); retrying in 500 ms');
    expect(out).toContain('[migrate] FATAL');
    expect(code).toBe(1);
  });

  it('does not retry when the budget is 0', () => {
    const { code, out } = run({ MIGRATE_CONNECT_TIMEOUT_MS: '0' });
    expect(out).not.toContain('retrying');
    expect(out).toContain('[migrate] FATAL');
    expect(code).toBe(1);
  });

  it('still refuses to run without DATABASE_URL', () => {
    const { code, out } = run({ DATABASE_URL: '' });
    expect(out).toContain('DATABASE_URL is not set');
    expect(code).toBe(1);
  });
});
