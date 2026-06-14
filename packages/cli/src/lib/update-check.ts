/**
 * Update awareness for the CLI.
 *
 * Two layers:
 *  1. Notifier (default ON) — once per 24h the CLI fetches the latest version
 *     from the npm registry and, if a newer one exists, prints a one-line
 *     "update available, run `bf upgrade`" notice. Non-blocking by design: the
 *     network fetch happens AFTER the command has produced its output, capped
 *     at ~1.5s, and only once a day. Suppressed in CI / non-TTY / piped output.
 *  2. Auto-update (default ON) — when the CLI sees a newer version it runs
 *     `npm i -g basefyio-cli@latest` itself, then transparently re-runs your
 *     original command on the new version. Opt out with BASEFYIO_AUTO_UPDATE=0
 *     (or BASEFYIO_NO_AUTO_UPDATE=1).
 *
 * A global npm install needs write access to the global prefix — fine on most
 * Windows setups and any node-version-manager install, but it can require sudo
 * on a system-wide macOS/Linux Node. So auto-update is best-effort: a failed
 * install is remembered per-version (autoUpdateFailedFor) and not retried on
 * every command; the notifier still nudges the user to run `bf upgrade`. It is
 * also skipped entirely in CI / non-TTY / piped output.
 */

import Conf from 'conf';
import https from 'node:https';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PACKAGE_NAME = 'basefyio-cli';

interface UpdateCache {
  latestVersion?: string;
  lastCheck?: number;
  /** Version whose auto-install already failed here — don't retry it every run. */
  autoUpdateFailedFor?: string;
}

const cache = new Conf<UpdateCache>({
  projectName: 'basefyio',
  configName: 'update-cache',
});

/** Commands that should never trigger a check, notice, or auto-update. */
const SKIP_COMMANDS = new Set(['upgrade', 'login', 'logout']);

function shouldSkip(commandName: string | undefined): boolean {
  if (!commandName || commandName.startsWith('-')) return true;
  return SKIP_COMMANDS.has(commandName);
}

/** Silence the notifier where it would be noise or break machine-readable output. */
function notifierDisabled(): boolean {
  return (
    !process.stdout.isTTY ||
    process.env.CI != null ||
    process.env.BASEFYIO_NO_UPDATE_NOTIFIER === '1' ||
    process.env.NODE_ENV === 'test'
  );
}

/** Plain numeric semver compare — our versions are x.y.z with no exotic ranges. */
function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  // Same release core: a stable release supersedes the current pre-release.
  return !latest.includes('-') && current.includes('-');
}

function fetchLatestVersion(timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      // The /latest endpoint only speaks full JSON — the abbreviated
      // "vnd.npm.install-v1+json" type returns 406 here.
      { headers: { Accept: 'application/json' }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 1_000_000) req.destroy();
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { version?: string };
            resolve(typeof json.version === 'string' ? json.version : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function printNotice(currentVersion: string): Promise<void> {
  const latest = cache.get('latestVersion');
  if (!latest || !isNewerVersion(latest, currentVersion)) return;

  // Lazy-load presentation deps so the happy path stays light. Awaited (not
  // fire-and-forget) so the write completes before the caller's process.exit.
  const [{ default: boxen }, { default: chalk }] = await Promise.all([
    import('boxen'),
    import('chalk'),
  ]);
  const body =
    `Update available ${chalk.dim(currentVersion)} ${chalk.reset('→')} ${chalk.green(latest)}\n` +
    `Run ${chalk.cyan('bf upgrade')} to update`;
  process.stderr.write(
    boxen(body, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'yellow',
      textAlignment: 'center',
    }) + '\n',
  );
}

/**
 * Run AFTER the command completes. Refreshes the cached latest version at most
 * once per day (capped network wait), then prints the notice if outdated.
 */
export async function finalizeUpdateCheck(
  currentVersion: string,
  commandName: string | undefined,
): Promise<void> {
  if (shouldSkip(commandName) || notifierDisabled()) return;

  const lastCheck = cache.get('lastCheck') ?? 0;
  if (Date.now() - lastCheck > CHECK_INTERVAL_MS) {
    // Write the timestamp first so a flaky network doesn't make every run probe.
    cache.set('lastCheck', Date.now());
    const latest = await fetchLatestVersion();
    if (latest) cache.set('latestVersion', latest);
  }

  await printNotice(currentVersion);
}

/**
 * Run BEFORE the command. Auto-update is ON by default: if a newer version is
 * already cached, install it and re-run the original command on it. Opt out
 * with BASEFYIO_AUTO_UPDATE=0 / BASEFYIO_NO_AUTO_UPDATE=1. Re-exec is guarded by
 * BASEFYIO_UPDATE_REEXEC so a failed/no-op install can never loop, and a
 * version that fails to install is not retried on every command.
 * Never returns when it updates — it re-execs and exits.
 */
export async function maybeAutoUpdate(
  currentVersion: string,
  commandName: string | undefined,
): Promise<void> {
  const optedOut =
    process.env.BASEFYIO_AUTO_UPDATE === '0' ||
    process.env.BASEFYIO_NO_AUTO_UPDATE === '1';
  if (
    optedOut ||
    process.env.BASEFYIO_UPDATE_REEXEC === '1' ||
    shouldSkip(commandName) ||
    notifierDisabled()
  ) {
    return;
  }

  const latest = cache.get('latestVersion');
  if (!latest || !isNewerVersion(latest, currentVersion)) return;

  // A previous auto-install of this exact version already failed here (e.g. a
  // system-wide Node needing sudo) — don't retry it every command; the notifier
  // will still nudge the user to run `bf upgrade`.
  if (cache.get('autoUpdateFailedFor') === latest) return;

  const { default: chalk } = await import('chalk');
  process.stderr.write(
    chalk.cyan(`Updating ${PACKAGE_NAME} ${currentVersion} → ${latest}…\n`),
  );

  try {
    const { execa } = await import('execa');
    await execa('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], { stdio: 'ignore' });
    cache.delete('autoUpdateFailedFor');
    process.stderr.write(chalk.green(`✓ Updated to ${latest}. Re-running your command…\n\n`));

    const result = await execa(
      process.execPath,
      [process.argv[1], ...process.argv.slice(2)],
      {
        stdio: 'inherit',
        reject: false,
        env: { ...process.env, BASEFYIO_UPDATE_REEXEC: '1' },
      },
    );
    process.exit(result.exitCode ?? 0);
  } catch (err: any) {
    // Best-effort: remember this version failed so we don't storm the registry
    // on every command, then fall through to running on the current version.
    cache.set('autoUpdateFailedFor', latest);
    process.stderr.write(
      chalk.yellow(`⚠ Auto-update failed (${err?.shortMessage || err?.message || 'unknown'}). ` +
        `Continuing on ${currentVersion}. Run "bf upgrade" to update manually.\n`),
    );
  }
}
