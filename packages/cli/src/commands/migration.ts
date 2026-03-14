import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig } from '../lib/config.js';
import { success, error, info, warning, createSpinner } from '../lib/ui.js';

const MIGRATIONS_DIR = 'migrations';
const TRACKING_TABLE = '_kb_migrations';

// ── Ensure tracking table exists ─────────────────────────────

async function ensureTrackingTable(projectId: string) {
  await apiClient.executeSQL(projectId, `
    CREATE TABLE IF NOT EXISTS "${TRACKING_TABLE}" (
      id        SERIAL PRIMARY KEY,
      name      TEXT    UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Parse up/down sections from a migration file ─────────────

function parseMigration(content: string): { up: string; down: string | null } {
  const upMatch = content.match(/--\s*up\s*\n([\s\S]*?)(?:--\s*down\s*\n|$)/i);
  const downMatch = content.match(/--\s*down\s*\n([\s\S]*?)$/i);

  if (upMatch) {
    return {
      up: upMatch[1].trim(),
      down: downMatch ? downMatch[1].trim() : null,
    };
  }

  // No markers → treat entire file as up migration
  return { up: content.trim(), down: null };
}

// ── Get applied migration names from DB ──────────────────────

async function getApplied(projectId: string): Promise<Set<string>> {
  try {
    const result = await apiClient.executeSQL(
      projectId,
      `SELECT name FROM "${TRACKING_TABLE}" ORDER BY applied_at`,
    );
    return new Set((result?.rows ?? []).map((r: any) => r.name));
  } catch {
    return new Set();
  }
}

// ── Get local migration files sorted by timestamp ────────────

async function getLocalMigrations(): Promise<string[]> {
  try {
    const files = await fs.readdir(MIGRATIONS_DIR);
    return files
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

export async function migrationNew(name: string) {
  if (!name?.trim()) {
    error('Provide a migration name:  kb migration new <name>');
    process.exit(1);
  }

  await fs.mkdir(MIGRATIONS_DIR, { recursive: true });

  const ts = new Date()
    .toISOString()
    .replace(/[-T:\.Z]/g, '')
    .slice(0, 14); // e.g. 20260314153000

  const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const filename = `${ts}_${safeName}.sql`;
  const filepath = path.join(MIGRATIONS_DIR, filename);

  const template = `-- Migration: ${safeName}
-- Created: ${new Date().toISOString()}

-- up

-- write your SQL here


-- down

-- write rollback SQL here (optional)

`;

  await fs.writeFile(filepath, template);
  success(`Created ${chalk.cyan(filepath)}`);
}

export async function migrationStatus() {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  kb link  or  kb init');
    process.exit(1);
  }

  const spinner = createSpinner('Checking migration status…');

  try {
    await ensureTrackingTable(config.projectId);
    const applied = await getApplied(config.projectId);
    const local = await getLocalMigrations();
    spinner.stop();

    if (!local.length) {
      info('No migration files found in ./migrations/');
      console.log(chalk.gray('  Create one:  kb migration new <name>'));
      return;
    }

    console.log();
    const nameW = Math.max(10, ...local.map((f) => f.length));
    console.log(
      `  ${'Migration'.padEnd(nameW)}  Status`,
    );
    console.log(chalk.gray(`  ${'─'.repeat(nameW + 12)}`));

    for (const file of local) {
      const isApplied = applied.has(file);
      const badge = isApplied ? chalk.green('✓ applied') : chalk.yellow('○ pending');
      console.log(`  ${chalk.cyan(file.padEnd(nameW))}  ${badge}`);
    }

    const pendingCount = local.filter((f) => !applied.has(f)).length;
    console.log();
    console.log(chalk.gray(`  ${local.length} migration(s) — ${applied.size} applied, ${pendingCount} pending`));
    if (pendingCount > 0) {
      console.log(chalk.gray('  Run  kb migration up  to apply pending migrations'));
    }
  } catch (err) {
    spinner.fail('Failed to get migration status');
    handleApiError(err);
  }
}

interface UpOptions {
  step?: string;
  dryRun?: boolean;
}

export async function migrationUp(options: UpOptions = {}) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  kb link  or  kb init');
    process.exit(1);
  }

  const maxStep = options.step ? parseInt(options.step, 10) : Infinity;

  const spinner = createSpinner('Preparing migrations…');

  try {
    await ensureTrackingTable(config.projectId);
    const applied = await getApplied(config.projectId);
    const local = await getLocalMigrations();
    const pending = local.filter((f) => !applied.has(f)).slice(0, maxStep);
    spinner.stop();

    if (!pending.length) {
      success('Already up to date');
      return;
    }

    console.log();
    info(`${pending.length} pending migration(s) to apply:`);
    pending.forEach((f) => console.log(chalk.gray(`    • ${f}`)));
    console.log();

    if (options.dryRun) {
      warning('Dry run — no changes made');
      return;
    }

    let applied_count = 0;

    for (const file of pending) {
      const sp = createSpinner(`Applying ${chalk.cyan(file)}…`);
      try {
        const content = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf-8');
        const { up } = parseMigration(content);

        if (!up) {
          sp.fail(`No SQL found in ${file}`);
          continue;
        }

        await apiClient.executeSQL(config.projectId!, up);
        await apiClient.executeSQL(
          config.projectId!,
          `INSERT INTO "${TRACKING_TABLE}" (name) VALUES ('${file.replace(/'/g, "''")}')`,
        );

        sp.succeed(`Applied ${chalk.cyan(file)}`);
        applied_count++;
      } catch (err: any) {
        sp.fail(`Failed: ${file}`);
        error(err.message || String(err));
        error('Migration stopped. Fix the error and run  kb migration up  again.');
        process.exit(1);
      }
    }

    console.log();
    success(`${applied_count} migration(s) applied`);
  } catch (err) {
    spinner.fail('Migration failed');
    handleApiError(err);
  }
}

interface DownOptions {
  step?: string;
  dryRun?: boolean;
}

export async function migrationDown(options: DownOptions = {}) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  kb link  or  kb init');
    process.exit(1);
  }

  const stepCount = options.step ? parseInt(options.step, 10) : 1;

  const spinner = createSpinner('Preparing rollback…');

  try {
    await ensureTrackingTable(config.projectId);
    const applied = await getApplied(config.projectId);
    const local = await getLocalMigrations();

    // Rollback in reverse order
    const toRollback = local
      .filter((f) => applied.has(f))
      .reverse()
      .slice(0, stepCount);

    spinner.stop();

    if (!toRollback.length) {
      info('Nothing to rollback');
      return;
    }

    console.log();
    info(`Rolling back ${toRollback.length} migration(s):`);
    toRollback.forEach((f) => console.log(chalk.gray(`    • ${f}`)));
    console.log();

    if (options.dryRun) {
      warning('Dry run — no changes made');
      return;
    }

    for (const file of toRollback) {
      const sp = createSpinner(`Rolling back ${chalk.cyan(file)}…`);
      try {
        const content = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf-8');
        const { down } = parseMigration(content);

        if (!down) {
          sp.fail(`No -- down section in ${file} — skipping`);
          continue;
        }

        await apiClient.executeSQL(config.projectId!, down);
        await apiClient.executeSQL(
          config.projectId!,
          `DELETE FROM "${TRACKING_TABLE}" WHERE name = '${file.replace(/'/g, "''")}'`,
        );

        sp.succeed(`Rolled back ${chalk.cyan(file)}`);
      } catch (err: any) {
        sp.fail(`Failed: ${file}`);
        error(err.message || String(err));
        process.exit(1);
      }
    }

    console.log();
    success(`${toRollback.length} migration(s) rolled back`);
  } catch (err) {
    spinner.fail('Rollback failed');
    handleApiError(err);
  }
}
