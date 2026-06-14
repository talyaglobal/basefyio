/**
 * Shared helpers for explaining why a global install failed and what to do.
 *
 * A `npm install -g` can fail because it writes into Node's *global* folder,
 * which on a system-wide Node (Homebrew/apt/system installer, or Program Files
 * on Windows) is owned by root/Administrator. The CLI can't elevate itself, so
 * when that happens we must tell the user (a) to re-run with sudo / as admin and
 * (b) *why* it's needed — otherwise "permission denied" looks like our bug.
 */

const PACKAGE_SPEC = 'basefyio-cli@latest';

/** True when an install error is an OS permission problem (needs sudo/admin). */
export function isPermissionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; errno?: string; shortMessage?: string; stderr?: string; message?: string };
  if (e.code === 'EACCES' || e.code === 'EPERM' || e.errno === 'EACCES' || e.errno === 'EPERM') {
    return true;
  }
  const text = `${e.shortMessage ?? ''} ${e.stderr ?? ''} ${e.message ?? ''}`.toLowerCase();
  return /eacces|eperm|permission denied|missing write access|operation not permitted|need (sudo|admin)/.test(text);
}

/**
 * A human explanation of the sudo/admin requirement plus the exact command to
 * run, tailored to the current OS. `chalk` is passed in so the caller controls
 * loading it.
 */
export function permissionHelp(chalk: {
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
}): string {
  if (process.platform === 'win32') {
    return [
      chalk.yellow('This update needs Administrator rights.'),
      '',
      'Open a new terminal with "Run as administrator", then run:',
      chalk.cyan(`  npm install -g ${PACKAGE_SPEC}`),
      '',
      chalk.dim('Why? `npm install -g` installs the CLI machine-wide, into a folder'),
      chalk.dim('Windows protects, so the install needs an elevated terminal.'),
      chalk.dim('(A Node version manager like nvm/fnm/volta installs into your user'),
      chalk.dim('folder and never needs elevation.)'),
    ].join('\n');
  }
  return [
    chalk.yellow('This update needs elevated permissions (sudo).'),
    '',
    'Re-run with sudo:',
    chalk.cyan(`  sudo npm install -g ${PACKAGE_SPEC}`),
    '',
    chalk.dim('Why sudo? `npm install -g` installs the CLI system-wide, into a folder'),
    chalk.dim('owned by root (e.g. /usr/local/lib/node_modules) that your user can\'t'),
    chalk.dim('write to. (A Node version manager like nvm/fnm/volta installs into your'),
    chalk.dim('home directory and never needs sudo.)'),
  ].join('\n');
}
