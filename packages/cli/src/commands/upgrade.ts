import chalk from 'chalk';
import { execa } from 'execa';
import { createSpinner } from '../lib/ui.js';

/**
 * Update the globally-installed CLI to the latest published version.
 * One command instead of asking users to remember the package name.
 */
export async function upgradeCommand() {
  const spinner = createSpinner('Updating basefyio CLI to the latest version…');
  try {
    await execa('npm', ['install', '-g', 'basefyio-cli@latest'], { stdio: 'pipe' });
    spinner.succeed('basefyio CLI updated');

    // Report the version we landed on (best-effort; never fail the command on it).
    const { stdout } = await execa('npm', ['view', 'basefyio-cli', 'version'], {
      stdio: 'pipe',
    }).catch(() => ({ stdout: '' }) as { stdout: string });
    if (stdout.trim()) {
      console.log(chalk.gray(`  Now on v${stdout.trim()}`));
    }
    console.log(chalk.gray('  Run  bf --help  to see commands'));
  } catch (err: any) {
    spinner.fail('Update failed');
    const { isPermissionError, permissionHelp } = await import('../lib/install-error.js');
    if (isPermissionError(err)) {
      console.error('\n' + permissionHelp(chalk) + '\n');
    } else {
      console.error(chalk.red(err?.shortMessage || err?.message || String(err)));
      console.error(chalk.yellow('Try manually:  npm install -g basefyio-cli@latest'));
    }
    process.exit(1);
  }
}
