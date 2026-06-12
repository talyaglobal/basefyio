import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig } from '../lib/config.js';
import { success, error, info, warning, createSpinner } from '../lib/ui.js';

const SAFETY_COLOR: Record<string, (s: string) => string> = {
  SAFE: chalk.green,
  POTENTIALLY_SAFE: chalk.yellow,
  DESTRUCTIVE: chalk.red,
};

// ── migrations plan ──────────────────────────────────────────

export async function migrationsPlan(opts: { fromVersion?: number; toVersion?: number } = {}) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  basefyio link  or  basefyio init');
    process.exit(1);
  }

  const spinner = createSpinner('Computing migration plan…');

  try {
    const result = await apiClient.planMigration(config.projectId, opts);
    spinner.stop();

    const { plan, fromVersion, toVersion, migrationRunId, sqlStatements } = result;

    console.log();
    console.log(
      chalk.bold(`Blueprint migration: v${fromVersion} → v${toVersion}`),
    );
    console.log(chalk.gray(`Run ID: ${migrationRunId}`));
    console.log();

    if (!plan.operations.length) {
      success('No changes detected between the two versions');
      return;
    }

    console.log(chalk.bold(`Operations (${plan.operations.length}):`));
    for (const op of plan.operations) {
      const color = SAFETY_COLOR[op.safety] ?? chalk.white;
      const badge = color(`[${op.safety}]`);
      console.log(`  ${badge}  ${op.detail}`);
    }

    if (plan.warnings.length) {
      console.log();
      console.log(chalk.bold('Warnings:'));
      plan.warnings.forEach(w => console.log(`  ${chalk.yellow('⚠')}  ${w}`));
    }

    if (plan.breakingChanges.length) {
      console.log();
      console.log(chalk.bold(chalk.red('Breaking changes:')));
      plan.breakingChanges.forEach(b => console.log(`  ${chalk.red('✗')}  ${b}`));
    }

    console.log();
    console.log(chalk.bold(`SQL statements (${sqlStatements.length}):`));
    sqlStatements.forEach(s => {
      const lines = s.split('\n');
      lines.forEach(l => console.log(chalk.gray(`  ${l}`)));
      console.log();
    });

    if (plan.hasDestructive) {
      warning('Plan contains DESTRUCTIVE changes. Apply with --force to proceed.');
      console.log(
        chalk.gray(
          `  basefyio migrations apply ${migrationRunId} --force`,
        ),
      );
    } else {
      info(`Apply this plan:`);
      console.log(chalk.gray(`  basefyio migrations apply ${migrationRunId}`));
    }
  } catch (err) {
    spinner.fail('Failed to compute migration plan');
    await handleApiError(err);
  }
}

// ── migrations apply ─────────────────────────────────────────

export async function migrationsApply(migrationRunId: string, opts: { force?: boolean } = {}) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  basefyio link  or  basefyio init');
    process.exit(1);
  }

  if (!migrationRunId) {
    error('Provide a migration run ID:  basefyio migrations apply <runId>');
    process.exit(1);
  }

  const spinner = createSpinner('Applying migration…');

  try {
    const result = await apiClient.applyMigration(config.projectId, migrationRunId, opts.force ?? false);
    spinner.stop();

    if (result.status === 'APPLIED') {
      success(`Migration applied — ${result.appliedStatements} statement(s) executed`);
    } else {
      error(`Migration FAILED after ${result.appliedStatements} statement(s)`);
      if (result.errorMessage) {
        console.log(chalk.red(`  ${result.errorMessage}`));
      }
      process.exit(1);
    }
  } catch (err) {
    spinner.fail('Failed to apply migration');
    await handleApiError(err);
  }
}

// ── migrations list ──────────────────────────────────────────

export async function migrationsList() {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  basefyio link  or  basefyio init');
    process.exit(1);
  }

  const spinner = createSpinner('Loading migration history…');

  try {
    const runs = await apiClient.listMigrations(config.projectId);
    spinner.stop();

    if (!runs.length) {
      info('No migration runs found for this project');
      console.log(chalk.gray('  Run:  basefyio migrations plan  to create one'));
      return;
    }

    const STATUS_COLOR: Record<string, (s: string) => string> = {
      APPLIED: chalk.green,
      FAILED: chalk.red,
      APPLYING: chalk.cyan,
      PENDING: chalk.yellow,
      ROLLED_BACK: chalk.gray,
    };

    console.log();
    console.log(
      `  ${'ID'.padEnd(36)}  ${'From'.padEnd(6)}  ${'To'.padEnd(6)}  ${'Status'.padEnd(12)}  Created`,
    );
    console.log(chalk.gray(`  ${'─'.repeat(90)}`));

    for (const run of runs) {
      const color = STATUS_COLOR[run.status] ?? chalk.white;
      const date = new Date(run.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      console.log(
        `  ${chalk.cyan(run.id.padEnd(36))}  ` +
          `${'v' + run.fromBlueprintVersion}`.padEnd(6) + '  ' +
          `${'v' + run.toBlueprintVersion}`.padEnd(6) + '  ' +
          color(run.status.padEnd(12)) + '  ' +
          chalk.gray(date),
      );
    }
    console.log();
  } catch (err) {
    spinner.fail('Failed to list migrations');
    await handleApiError(err);
  }
}
