import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('kb')
  .description('Kolaybase CLI — manage your Kolaybase projects')
  .version(pkg.version);

// ── Authentication ──────────────────────────────────────────

// Proactively refresh the access token before every command so the CLI session
// stays alive until the user explicitly runs `kb logout`.
program.hook('preAction', async (thisCommand) => {
  const cmdName = thisCommand.args?.[0] ?? thisCommand.name();
  // Skip refresh for login/logout — they manage tokens themselves
  if (cmdName === 'login' || cmdName === 'logout') return;
  const { ensureFreshToken } = await import('./lib/api.js');
  await ensureFreshToken();
});

program
  .command('login')
  .description('Authenticate with the Kolaybase platform')
  .option('--api-url <url>', 'Platform API URL (default: https://api.kolaybase.com)')
  .action(async (options) => {
    const { loginCommand } = await import('./commands/login.js');
    await loginCommand(options);
  });

program
  .command('logout')
  .description('Sign out and clear saved credentials')
  .action(async () => {
    const { logoutCommand } = await import('./commands/logout.js');
    await logoutCommand();
  });

// ── Project lifecycle ───────────────────────────────────────

program
  .command('init')
  .description('Create a new Kolaybase project and link it to the current directory')
  .option('-n, --name <name>', 'Project name')
  .action(async (options) => {
    const { initCommand } = await import('./commands/init.js');
    await initCommand(options);
  });

program
  .command('link')
  .description('Link current directory to an existing remote project')
  .option('--project-id <id>', 'Project ID to link directly')
  .action(async (options) => {
    const { linkCommand } = await import('./commands/link.js');
    await linkCommand(options);
  });

program
  .command('unlink')
  .description('Remove the project link from the current directory')
  .action(async () => {
    const { unlinkProject } = await import('./commands/link.js');
    await unlinkProject();
  });

// ── Project info ────────────────────────────────────────────

program
  .command('status')
  .description('Show credentials, keys, and connection info for the linked project')
  .option('--show-keys', 'Reveal secret values instead of masking them')
  .action(async (options) => {
    const { statusCommand } = await import('./commands/status.js');
    await statusCommand(options);
  });

program
  .command('projects')
  .alias('list')
  .description('List all projects in your team')
  .action(async () => {
    const { projectsCommand } = await import('./commands/projects.js');
    await projectsCommand();
  });

program
  .command('projects:create')
  .description('Create a new project without linking')
  .option('-n, --name <name>', 'Project name')
  .option('-d, --description <description>', 'Project description')
  .action(async (options) => {
    const { createProject } = await import('./commands/projects.js');
    await createProject(options);
  });

program
  .command('projects:delete <projectId>')
  .description('Delete a remote project (requires confirmation)')
  .action(async (projectId) => {
    const { deleteProject } = await import('./commands/projects.js');
    await deleteProject(projectId);
  });

// ── Database ────────────────────────────────────────────────

const db = program
  .command('db')
  .description('Manage the project database');

db.command('push')
  .description('Push local schema to the project database')
  .action(async () => {
    const { dbPush } = await import('./commands/db.js');
    await dbPush();
  });

db.command('pull')
  .description('Introspect the remote database and save schema locally')
  .action(async () => {
    const { dbPull } = await import('./commands/db.js');
    await dbPull();
  });

db.command('reset')
  .description('Drop all tables in the project database')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (options) => {
    const { dbReset } = await import('./commands/db.js');
    await dbReset(options);
  });

db.command('seed')
  .description('Run the seed file against the project database')
  .action(async () => {
    const { dbSeed } = await import('./commands/db.js');
    await dbSeed();
  });

db.command('dump')
  .description('Dump the full database schema to SQL')
  .option('-o, --output <file>', 'Output file', 'schema.sql')
  .action(async (options) => {
    const { dbDump } = await import('./commands/db.js');
    await dbDump(options);
  });

db.command('diff')
  .description('Show schema differences between local Prisma schema and remote database')
  .action(async () => {
    const { dbDiff } = await import('./commands/db.js');
    await dbDiff();
  });

db.command('execute')
  .description('Execute a SQL file or inline query against the project database')
  .option('-f, --file <path>', 'SQL file to execute')
  .option('-q, --query <sql>', 'SQL query to run directly')
  .action(async (options) => {
    const { dbExecute } = await import('./commands/db.js');
    await dbExecute(options);
  });

// ── Inspect ─────────────────────────────────────────────────

program
  .command('inspect')
  .description('Show database tables, columns, sizes, and row counts')
  .option('-t, --table <name>', 'Inspect a specific table')
  .action(async (options) => {
    const { inspectCommand } = await import('./commands/inspect.js');
    await inspectCommand(options);
  });

// ── Code generation ─────────────────────────────────────────

const gen = program
  .command('gen')
  .description('Generate code from the project database');

gen.command('types')
  .description('Generate TypeScript types from the database schema')
  .option('-o, --output <path>', 'Output directory', './types')
  .action(async (options) => {
    const { genTypes } = await import('./commands/gen.js');
    await genTypes(options);
  });

gen.command('client')
  .description('Generate a ready-to-use API client')
  .option('-l, --lang <language>', 'Language: typescript | javascript | python', 'typescript')
  .option('-o, --output <path>', 'Output directory', './lib')
  .action(async (options) => {
    const { genClient } = await import('./commands/gen.js');
    await genClient(options);
  });

// ── Migrations ──────────────────────────────────────────────

const migration = program
  .command('migration')
  .alias('migrate')
  .description('Manage database migrations');

migration
  .command('new <name>')
  .description('Create a new migration file')
  .action(async (name) => {
    const { migrationNew } = await import('./commands/migration.js');
    await migrationNew(name);
  });

migration
  .command('up')
  .description('Apply pending migrations')
  .option('-s, --step <n>', 'Apply at most N migrations')
  .option('--dry-run', 'Preview without applying')
  .action(async (options) => {
    const { migrationUp } = await import('./commands/migration.js');
    await migrationUp(options);
  });

migration
  .command('down')
  .description('Rollback the last applied migration')
  .option('-s, --step <n>', 'Roll back N migrations (default: 1)')
  .option('--dry-run', 'Preview without rolling back')
  .action(async (options) => {
    const { migrationDown } = await import('./commands/migration.js');
    await migrationDown(options);
  });

migration
  .command('status')
  .alias('list')
  .description('Show applied and pending migrations')
  .action(async () => {
    const { migrationStatus } = await import('./commands/migration.js');
    await migrationStatus();
  });

// ── Top-level shortcuts ──────────────────────────────────────

program
  .command('push')
  .description('Shortcut for: kb db push')
  .action(async () => {
    const { dbPush } = await import('./commands/db.js');
    await dbPush();
  });

// ── Logs ────────────────────────────────────────────────────

program
  .command('logs')
  .description('Show SQL audit logs for the linked project')
  .option('-n, --tail <lines>', 'Number of recent entries', '50')
  .action(async (options) => {
    const { logsCommand } = await import('./commands/logs.js');
    await logsCommand(options);
  });

// ── Secrets / env ───────────────────────────────────────────

const secrets = program
  .command('secrets')
  .description('Manage local .env variables for the linked project');

secrets.command('list')
  .description('List all variables (sensitive values masked)')
  .action(async () => {
    const { listSecrets } = await import('./commands/secrets.js');
    await listSecrets();
  });

secrets.command('set <key> <value>')
  .description('Set or update a variable')
  .action(async (key, value) => {
    const { setSecret } = await import('./commands/secrets.js');
    await setSecret(key, value);
  });

secrets.command('unset <key>')
  .description('Remove a variable')
  .action(async (key) => {
    const { unsetSecret } = await import('./commands/secrets.js');
    await unsetSecret(key);
  });

program.parse();
