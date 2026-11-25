import chalk from 'chalk';
import inquirer from 'inquirer';
import { apiClient, handleApiError } from '../lib/api.js';
import { getLocalEnv, getProjectConfig, isLoggedIn } from '../lib/config.js';
import { resolveProjectId } from '../lib/backups.js';
import { createSpinner, error, info, printJson, printTable, warning } from '../lib/ui.js';

/** An extra database role as the API lists it. `password` is only set in a create answer. */
export interface DbRole {
  id: string;
  label: string;
  roleName: string;
  kind: 'login' | 'group';
  memberships: string[];
  password: string | null;
  createdAt: string;
}

/** The slice of the API client these commands use, so they can run against a stub. */
export interface DbRolesApi {
  listDbRoles(projectId: string): Promise<DbRole[]>;
  createDbRole(projectId: string, body: { label: string; name?: string; kind?: 'login' | 'group'; memberOf?: string[] }): Promise<DbRole>;
  resetDbRolePassword(projectId: string, roleId: string): Promise<{ password: string }>;
  dropDbRole(projectId: string, roleId: string): Promise<{ message: string; warnings: string[] }>;
}

export interface CreateRoleOptions {
  label?: string;
  group?: boolean;
  memberOf?: string;
}

/** The create request: label defaults to the name; `--member-of a,b` becomes a list. */
export function createRoleBody(name: string | undefined, options: CreateRoleOptions) {
  const label = (options.label ?? name ?? '').trim();
  if (!label) throw new Error('Give a role name or --label');
  const memberOf = (options.memberOf ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    label,
    ...(name ? { name: name.trim() } : {}),
    ...(options.group ? { kind: 'group' as const } : {}),
    ...(memberOf.length ? { memberOf } : {}),
  };
}

/** A role picked by id, real role name or label. */
export function findRole(roles: DbRole[], ref: string): DbRole {
  const hit = roles.find((r) => r.id === ref || r.roleName === ref) ?? roles.filter((r) => r.label === ref);
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0];
    throw new Error(hit.length ? `Several roles are labelled "${ref}"; use the role name` : `No database role "${ref}"`);
  }
  return hit;
}

export function roleRows(roles: DbRole[]): string[][] {
  return roles.map((r) => [r.roleName, r.kind, r.label, r.memberships?.length ? r.memberships.join(', ') : '-', r.id]);
}

export async function runCreateRole(api: DbRolesApi, projectId: string, name: string | undefined, options: CreateRoleOptions) {
  return api.createDbRole(projectId, createRoleBody(name, options));
}

export async function runResetPassword(api: DbRolesApi, projectId: string, ref: string) {
  const role = findRole(await api.listDbRoles(projectId), ref);
  const { password } = await api.resetDbRolePassword(projectId, role.id);
  return { role, password };
}

export async function runDropRole(api: DbRolesApi, projectId: string, ref: string) {
  const role = findRole(await api.listDbRoles(projectId), ref);
  return { role, ...(await api.dropDbRole(projectId, role.id)) };
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

export async function dbRolesList(options: { project?: string; json?: boolean }) {
  const projectId = await resolveProject(options.project);
  const spinner = createSpinner('Fetching database roles...');
  try {
    const roles = await apiClient.listDbRoles(projectId);
    spinner.stop();
    if (options.json) return printJson(roles);
    if (!roles.length) return info('No extra database roles yet. Create one with:  basefyio db roles create <name>');
    printTable(['Role', 'Kind', 'Label', 'Member of', 'Id'], roleRows(roles));
  } catch (err: any) {
    spinner.fail('Could not list database roles');
    await handleApiError(err);
  }
}

export async function dbRolesCreate(name: string | undefined, options: CreateRoleOptions & { project?: string; json?: boolean }) {
  const projectId = await resolveProject(options.project);
  const spinner = createSpinner('Creating database role...');
  try {
    const role = await runCreateRole(apiClient, projectId, name, options);
    spinner.succeed(`Database role ${role.roleName} created`);
    if (options.json) return printJson(role);
    if (role.password) console.log(chalk.gray('Password (shown once, store it now):'), chalk.cyan(role.password));
  } catch (err: any) {
    spinner.fail('Database role creation failed');
    await handleApiError(err);
  }
}

export async function dbRolesResetPassword(ref: string, options: { project?: string; force?: boolean }) {
  const projectId = await resolveProject(options.project);
  warning('Clients using this role must be updated with the new password when they reconnect.');
  if (!(await confirm(`Give ${ref} a new password now?`, options.force))) return info('Cancelled');
  const spinner = createSpinner('Resetting password...');
  try {
    const { role, password } = await runResetPassword(apiClient, projectId, ref);
    spinner.succeed(`New password for ${role.roleName}`);
    console.log(chalk.gray('Password (shown once):'), chalk.cyan(password));
  } catch (err: any) {
    spinner.fail('Password reset failed');
    await handleApiError(err);
  }
}

export async function dbRolesDrop(ref: string, options: { project?: string; force?: boolean }) {
  const projectId = await resolveProject(options.project);
  if (!(await confirm(`Drop database role ${ref}? Clients using it lose access.`, options.force))) return info('Cancelled');
  const spinner = createSpinner('Dropping database role...');
  try {
    const { role, warnings } = await runDropRole(apiClient, projectId, ref);
    spinner.succeed(`Database role ${role.roleName} dropped`);
    for (const w of warnings ?? []) warning(w);
  } catch (err: any) {
    spinner.fail('Drop failed');
    await handleApiError(err);
  }
}
