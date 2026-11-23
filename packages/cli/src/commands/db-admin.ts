import chalk from 'chalk';
import inquirer from 'inquirer';
import { apiClient, handleApiError } from '../lib/api.js';
import { getLocalEnv, getProjectConfig, isLoggedIn } from '../lib/config.js';
import { resolveProjectId } from '../lib/backups.js';
import { createSpinner, error, info, success, warning } from '../lib/ui.js';

export type VectorAction = 'status' | 'enable' | 'disable';

/** The slice of the API client these commands use, so they can run against a stub. */
export interface DbAdminApi {
  getEmbeddingStatus(projectId: string): Promise<{ pgvectorEnabled: boolean; embeddingCount?: number | null }>;
  enableEmbeddings(projectId: string): Promise<{ message: string }>;
  disableEmbeddings(projectId: string): Promise<{ message: string }>;
  rotateDbPassword(projectId: string, password?: string): Promise<{ password: string }>;
}

export function describeVectorStatus(s: { pgvectorEnabled: boolean; embeddingCount?: number | null }): string {
  if (!s.pgvectorEnabled) return 'pgvector is off';
  return typeof s.embeddingCount === 'number'
    ? `pgvector is on (${s.embeddingCount} embedding${s.embeddingCount === 1 ? '' : 's'} stored)`
    : 'pgvector is on';
}

/** Runs one pgvector action and returns the line to show. No I/O besides the API calls. */
export async function runVectorAction(api: DbAdminApi, projectId: string, action: VectorAction): Promise<string> {
  if (action === 'enable') {
    await api.enableEmbeddings(projectId);
    return 'pgvector enabled';
  }
  if (action === 'disable') {
    await api.disableEmbeddings(projectId);
    return 'pgvector disabled (embedding tables kept)';
  }
  return describeVectorStatus(await api.getEmbeddingStatus(projectId));
}

/** Rotates the owner password. A blank `--password` means "let the server generate one". */
export async function runRotatePassword(api: DbAdminApi, projectId: string, password?: string): Promise<string> {
  const chosen = password?.trim() || undefined;
  const res = await api.rotateDbPassword(projectId, chosen);
  return res.password;
}

async function resolveProject(flag?: string): Promise<string> {
  if (!isLoggedIn()) {
    error('Not logged in. Run:  basefyio login');
    process.exit(1);
  }
  const [config, env] = await Promise.all([getProjectConfig(), getLocalEnv()]);
  try {
    return resolveProjectId({ flag, config, env });
  } catch (err: any) {
    error(err.message);
    process.exit(1);
  }
}

async function confirm(message: string, force?: boolean): Promise<boolean> {
  if (force) return true;
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: false }]);
  return ok;
}

export async function dbVectorCommand(action: VectorAction, options: { project?: string; force?: boolean }) {
  const projectId = await resolveProject(options.project);
  if (action === 'disable' && !(await confirm('Turn pgvector off for this project?', options.force))) {
    info('Cancelled');
    return;
  }
  const spinner = createSpinner(action === 'status' ? 'Reading pgvector status...' : `Running vector ${action}...`);
  try {
    const line = await runVectorAction(apiClient, projectId, action);
    spinner.succeed(line);
  } catch (err: any) {
    spinner.fail(`pgvector ${action} failed`);
    await handleApiError(err);
  }
}

export async function dbRotatePassword(options: { project?: string; password?: string; force?: boolean }) {
  const projectId = await resolveProject(options.project);
  warning('Every client using the current database password (apps, DATABASE_URL, the pooler) must be updated.');
  if (!(await confirm('Rotate the database password now?', options.force))) {
    info('Cancelled');
    return;
  }
  const spinner = createSpinner('Rotating database password...');
  try {
    const password = await runRotatePassword(apiClient, projectId, options.password);
    spinner.succeed('Database password rotated');
    if (!options.password) {
      console.log(chalk.gray('New password (shown once):'), chalk.cyan(password));
    }
    success('Fetch fresh connection strings with:  basefyio status');
  } catch (err: any) {
    spinner.fail('Password rotation failed');
    await handleApiError(err);
  }
}
