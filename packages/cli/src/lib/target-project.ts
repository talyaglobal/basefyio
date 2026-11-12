import inquirer from 'inquirer';
import { apiClient } from './api.js';
import { resolveProjectId } from './backups.js';
import { getLocalEnv, getProjectConfig, isLoggedIn } from './config.js';
import { error, info } from './ui.js';

/** Fields of `GET /api/projects/:id` the project-level commands rely on. */
export interface TargetProject {
  id: string;
  name: string;
  slug: string;
  teamId: string;
  dbUser?: string;
  dbReadonlyUser?: string | null;
}

export function requireLogin(): void {
  if (!isLoggedIn()) {
    error('Not logged in. Run:  basefyio login');
    process.exit(1);
  }
}

/** The project a command acts on: `--project`, else the linked project, else `BASEFYIO_PROJECT_ID` in .env. */
export async function resolveTargetProject(flag?: string): Promise<TargetProject> {
  const [config, env] = await Promise.all([getProjectConfig(), getLocalEnv()]);
  let projectId: string;
  try {
    projectId = resolveProjectId({ flag, config, env });
  } catch (err: any) {
    error(err.message);
    process.exit(1);
  }
  const project = await apiClient.getProject(projectId);
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    teamId: project.teamId,
    dbUser: project.dbUser,
    dbReadonlyUser: project.dbReadonlyUser ?? null,
  };
}

/**
 * Ask before a change the user cannot take back.
 *
 * `--yes` skips the question and is required when there is no terminal to ask
 * in, so a script never hangs on a prompt and never proceeds by default.
 * With `typeName`, the project name must be typed exactly.
 */
export async function confirmOrExit(opts: {
  yes?: boolean;
  action: string;
  message: string;
  typeName?: string;
}): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    error(`Refusing to ${opts.action} without --yes in a non-interactive session.`);
    process.exit(1);
  }
  if (opts.typeName) {
    const { typed } = await inquirer.prompt([
      { type: 'input', name: 'typed', message: `${opts.message} Type the project name to confirm:` },
    ]);
    if (typed !== opts.typeName) {
      info('Cancelled — the name did not match.');
      return false;
    }
    return true;
  }
  const { confirm } = await inquirer.prompt([
    { type: 'confirm', name: 'confirm', message: opts.message, default: false },
  ]);
  if (!confirm) info('Cancelled');
  return !!confirm;
}
