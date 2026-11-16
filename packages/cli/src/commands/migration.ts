import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig } from '../lib/config.js';
import { success, error, info, warning, createSpinner } from '../lib/ui.js';

const MIGRATIONS_DIR = 'migrations';
const TRACKING_TABLE = '_bf_migrations';

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

// ── Read the applied migration set ───────────────────────────
//
// The SQL endpoint pages every SELECT (default 100, max 1000 rows per page), so
// a single unpaged request silently truncated the applied set once a project
// passed 100 migrations — `status` under-counted and `up` re-ran migrations that
// were already applied. We page through the whole set here, and we never treat a
// failed read as "nothing applied": that turned a transient 5xx into "re-apply
// every migration from the first". Only a missing tracking table means empty,
// and ensureTrackingTable() creates it before any read, so a read that fails is
// a real failure and must stop the command.

const PAGE_SIZE = 1000;
const MAX_PAGES = 1000; // 1,000,000 tracked migrations — a loop backstop, never reached in practice

/** A thin, mockable view of the SQL endpoint for the pieces that need paging. */
export type SqlExecutor = (
  query: string,
  opts?: { page?: number; limit?: number; countTotal?: boolean },
) => Promise<{ rows: Record<string, unknown>[]; total?: number | null }>;

/**
 * Read every applied migration name, paging until a short page ends the set.
 * Throws on any read failure (so the caller aborts rather than guessing), and
 * refuses to return a short list when the server reports a larger exact total.
 */
export async function fetchAppliedSet(
  exec: SqlExecutor,
  table = TRACKING_TABLE,
): Promise<Set<string>> {
  const names = new Set<string>();
  let page = 1;
  let total: number | null | undefined = null;

  for (;;) {
    const res = await exec(`SELECT name FROM "${table}" ORDER BY applied_at`, {
      page,
      limit: PAGE_SIZE,
      countTotal: page === 1,
    });
    const rows = res?.rows ?? [];
    for (const r of rows) {
      const name = (r as { name?: unknown }).name;
      if (typeof name === 'string') names.add(name);
    }
    if (page === 1) total = res?.total;

    if (rows.length < PAGE_SIZE) break; // a short (or empty) page is the last one
    page += 1;
    if (page > MAX_PAGES) {
      throw new Error(
        `Refusing to guess the applied set: more than ${MAX_PAGES * PAGE_SIZE} tracked migrations.`,
      );
    }
  }

  // The server caps its exact count at 10000; below that it is reliable. If we
  // read fewer names than it reports, do not proceed with a short list — that is
  // exactly the state that re-runs already-applied migrations.
  if (typeof total === 'number' && total <= 10000 && names.size < total) {
    throw new Error(
      `Read ${names.size} of ${total} applied migrations; aborting rather than re-running the rest. Please try again.`,
    );
  }
  return names;
}

/** Pending = local files not yet applied, capped at maxStep (Infinity = all). */
export function computePending(
  local: string[],
  applied: Set<string>,
  maxStep: number,
): string[] {
  return local.filter((f) => !applied.has(f)).slice(0, maxStep);
}

/**
 * One multi-statement body: the up SQL and its tracking INSERT. The SQL endpoint
 * runs a multi-statement body unpaginated in a single implicit transaction, so
 * the change and its record commit together or not at all — no more "applied but
 * not recorded, so the next run applies it again".
 */
export function buildApplySql(table: string, file: string, up: string): string {
  const name = file.replace(/'/g, "''");
  const body = up.replace(/;\s*$/, '');
  return `${body};\nINSERT INTO "${table}" (name) VALUES ('${name}')`;
}

/** The down SQL and the tracking DELETE as one atomic body (mirror of apply). */
export function buildRollbackSql(table: string, file: string, down: string): string {
  const name = file.replace(/'/g, "''");
  const body = down.replace(/;\s*$/, '');
  return `${body};\nDELETE FROM "${table}" WHERE name = '${name}'`;
}

/** Surface the server's status code and message, not axios's generic string. */
export function serverErrorMessage(err: any): string {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const message = body?.message || body?.error || err?.message || String(err);
  return status ? `${status} — ${message}` : message;
}

/** Bind the SQL endpoint to a project as a mockable executor. */
function projectExecutor(projectId: string): SqlExecutor {
  return (query, opts) => apiClient.executeSQL(projectId, query, opts);
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
    error('Provide a migration name:  basefyio migration new <name>');
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
    error('Not linked to a project. Run:  basefyio link  or  basefyio init');
    process.exit(1);
  }

  const spinner = createSpinner('Checking migration status…');

  try {
    await ensureTrackingTable(config.projectId);
    const applied = await fetchAppliedSet(projectExecutor(config.projectId));
    const local = await getLocalMigrations();
    spinner.stop();

    if (!local.length) {
      info('No migration files found in ./migrations/');
      console.log(chalk.gray('  Create one:  basefyio migration new <name>'));
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
      console.log(chalk.gray('  Run  basefyio migration up  to apply pending migrations'));
    }
  } catch (err) {
    spinner.fail('Failed to get migration status');
    await handleApiError(err);
  }
}

interface UpOptions {
  step?: string;
  dryRun?: boolean;
}

export async function migrationUp(options: UpOptions = {}) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  basefyio link  or  basefyio init');
    process.exit(1);
  }

  const maxStep = options.step ? parseInt(options.step, 10) : Infinity;

  const spinner = createSpinner('Preparing migrations…');

  try {
    await ensureTrackingTable(config.projectId);
    const applied = await fetchAppliedSet(projectExecutor(config.projectId));
    const local = await getLocalMigrations();
    const pending = computePending(local, applied, maxStep);
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

        // Apply the migration and record it in one atomic request, so a failure
        // can never leave a migration applied but unrecorded (which would re-run
        // it next time). If the tracking row violates UNIQUE(name), the up rolls
        // back with it.
        await apiClient.executeSQL(config.projectId!, buildApplySql(TRACKING_TABLE, file, up));

        sp.succeed(`Applied ${chalk.cyan(file)}`);
        applied_count++;
      } catch (err: any) {
        sp.fail(`Failed: ${file}`);
        error(serverErrorMessage(err));
        error('Migration stopped. Fix the error and run  basefyio migration up  again.');
        process.exit(1);
      }
    }

    console.log();
    success(`${applied_count} migration(s) applied`);
  } catch (err) {
    spinner.fail('Migration failed');
    await handleApiError(err);
  }
}

interface DownOptions {
  step?: string;
  dryRun?: boolean;
}

export async function migrationDown(options: DownOptions = {}) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  basefyio link  or  basefyio init');
    process.exit(1);
  }

  const stepCount = options.step ? parseInt(options.step, 10) : 1;

  const spinner = createSpinner('Preparing rollback…');

  try {
    await ensureTrackingTable(config.projectId);
    const applied = await fetchAppliedSet(projectExecutor(config.projectId));
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

        // Run the down SQL and remove the tracking row in one atomic request,
        // so a rollback is never recorded as undone while its SQL failed, or
        // vice versa.
        await apiClient.executeSQL(config.projectId!, buildRollbackSql(TRACKING_TABLE, file, down));

        sp.succeed(`Rolled back ${chalk.cyan(file)}`);
      } catch (err: any) {
        sp.fail(`Failed: ${file}`);
        error(serverErrorMessage(err));
        process.exit(1);
      }
    }

    console.log();
    success(`${toRollback.length} migration(s) rolled back`);
  } catch (err) {
    spinner.fail('Rollback failed');
    await handleApiError(err);
  }
}
