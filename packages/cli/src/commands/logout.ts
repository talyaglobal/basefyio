import chalk from 'chalk';
import { clearAuthTokens, clearUserConfig } from '../lib/config.js';
import { printLogo } from '../lib/ui.js';

export async function logoutCommand() {
  printLogo();
  clearAuthTokens();
  clearUserConfig();
  console.log(chalk.green('✔ Logged out successfully'));
  console.log(chalk.gray('  Run  basefyio login  to sign in again'));
}
