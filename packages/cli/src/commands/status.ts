import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig, isLoggedIn } from '../lib/config.js';
import { error, printHeader, createSpinner } from '../lib/ui.js';
import { resolveProjectSecrets, type ResolvedSecrets } from '../lib/secrets.js';

interface StatusOptions {
  showKeys?: boolean;
}

export async function statusCommand(options: StatusOptions) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  basefyio link  or  basefyio init');
    process.exit(1);
  }

  if (!isLoggedIn()) {
    error('Not logged in. Run:  basefyio login');
    process.exit(1);
  }

  const spinner = createSpinner('Fetching project details…');

  try {
    const project = await apiClient.getProject(config.projectId);

    // The project read carries no password or service key (#14). --show-keys asks the reveal
    // endpoint, which needs a team owner, admin or the credentials permission and is recorded
    // in the project's activity log.
    // An older server has no reveal route (404) but still returns the fields on the project read.
    let secrets: ResolvedSecrets['secrets'] = null;
    let secretsNote: string | null = null;
    if (options.showKeys) {
      const projectId = config.projectId;
      const resolved = await resolveProjectSecrets(() => apiClient.revealProjectSecrets(projectId), { project });
      secrets = resolved.secrets;
      secretsNote = resolved.message;
    }
    spinner.stop();

    const HIDDEN = '••••••';
    const mask = (val: string | null | undefined) => {
      if (!val) return HIDDEN;
      return options.showKeys ? val : val.slice(0, 6) + '•'.repeat(Math.max(0, val.length - 10)) + val.slice(-4);
    };
    const password = secrets?.password ?? null;
    const serviceKey = secrets?.serviceKey ?? null;

    printHeader(`Project: ${project.name}`);
    console.log();

    // ── General ──────────────────────────────────────────
    section('General');
    row('Project ID', project.id);
    row('Name', project.name);
    row('Slug', project.slug);
    row('Status', statusBadge(project.status));
    row('Created', new Date(project.createdAt).toLocaleString());
    console.log();

    // ── Database ─────────────────────────────────────────
    section('Database');
    row('Host', project.dbHost);
    row('Port', String(project.dbPort));
    row('Database', project.dbName);
    row('User', project.dbUser);
    row('Password', password ?? HIDDEN);
    console.log();

    const connStr = `postgresql://${project.dbUser}:${password ? encodeURIComponent(password) : HIDDEN}@${project.dbHost}:${project.dbPort}/${project.dbName}`;
    row('Connection string', chalk.cyan(connStr));
    console.log();

    // ── Auth / Keycloak ──────────────────────────────────
    section('Authentication (Keycloak)');
    row('Realm', project.keycloakRealm);
    row('Anon Key', mask(project.anonKey));
    row(
      'Service Key',
      serviceKey
        ? serviceKey
        : secrets && secrets.serviceKeyRevealable === false
          ? chalk.gray('in use, no longer shown — rotate it or create a secret key')
          : HIDDEN,
    );
    console.log();

    if (secretsNote) {
      console.log(chalk.yellow(`  ${secretsNote}`));
      console.log();
    }

    // ── Hint ─────────────────────────────────────────────
    if (!options.showKeys) {
      console.log(chalk.gray('  Tip: use  basefyio status --show-keys  to reveal secrets'));
    }
    console.log();
  } catch (err) {
    spinner.fail('Could not fetch project');
    await handleApiError(err);
  }
}

function section(title: string) {
  console.log(chalk.bold(`  ${title}`));
}

function row(label: string, value: string) {
  console.log(`    ${chalk.gray(label.padEnd(20))} ${value}`);
}

function statusBadge(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return chalk.green('● ACTIVE');
    case 'PAUSED':
      return chalk.yellow('● PAUSED');
    case 'DELETED':
      return chalk.red('● DELETED');
    default:
      return status;
  }
}
