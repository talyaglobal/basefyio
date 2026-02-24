import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { initCommand } from './commands/init.js';
import { projectsCommand, createProject, deleteProject } from './commands/projects.js';
import { statusCommand } from './commands/status.js';
import { linkCommand, unlinkProject } from './commands/link.js';
import { logsCommand } from './commands/logs.js';

const program = new Command();

program
  .name('kb')
  .description('Kolaybase CLI — manage your Kolaybase projects')
  .version('0.1.0');

// ── Authentication ──────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with the Kolaybase platform')
  .option('--api-url <url>', 'Platform API URL (default: https://api.kolaybase.com)')
  .action(loginCommand);

// ── Project lifecycle ───────────────────────────────────────

program
  .command('init')
  .description('Create a new Kolaybase project and link it to the current directory')
  .option('-n, --name <name>', 'Project name')
  .action(initCommand);

program
  .command('link')
  .description('Link current directory to an existing remote project')
  .option('--project-id <id>', 'Project ID to link directly')
  .action(linkCommand);

program
  .command('unlink')
  .description('Remove the project link from the current directory')
  .action(unlinkProject);

// ── Project info ────────────────────────────────────────────

program
  .command('status')
  .description('Show credentials, keys, and connection info for the linked project')
  .option('--show-keys', 'Reveal secret values instead of masking them')
  .action(statusCommand);

program
  .command('projects')
  .alias('list')
  .description('List all projects in your team')
  .action(projectsCommand);

program
  .command('projects:create')
  .description('Create a new project without linking')
  .option('-n, --name <name>', 'Project name')
  .option('-d, --description <description>', 'Project description')
  .action(createProject);

program
  .command('projects:delete <projectId>')
  .description('Delete a remote project (requires confirmation)')
  .action(deleteProject);

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

// ── Logs ────────────────────────────────────────────────────

program
  .command('logs')
  .description('Show SQL audit logs for the linked project')
  .option('-n, --tail <lines>', 'Number of recent entries', '50')
  .action(logsCommand);

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
