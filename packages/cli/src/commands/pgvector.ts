import chalk from 'chalk';
import type { Ora } from 'ora';
import { apiClient, handleApiError } from '../lib/api.js';
import { describeDisableOutcome, embeddingStatusRows, type EmbeddingStatus } from '../lib/pgvector.js';
import { confirmOrExit, requireLogin, resolveTargetProject } from '../lib/target-project.js';
import { createSpinner, info, printJson, success, warning } from '../lib/ui.js';

interface PgvectorOptions {
  project?: string;
  json?: boolean;
}

interface PgvectorDisableOptions extends PgvectorOptions {
  dropData?: boolean;
  yes?: boolean;
}

function printStatus(status: EmbeddingStatus): void {
  const rows = embeddingStatusRows(status);
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    console.log(`  ${chalk.gray(label.padEnd(width))}  ${value}`);
  }
}

// pgvector status

export async function pgvectorStatus(options: PgvectorOptions) {
  requireLogin();
  let spinner: Ora | null = null;
  try {
    const project = await resolveTargetProject(options.project);
    spinner = options.json ? null : createSpinner(`Reading pgvector status of ${chalk.cyan(project.name)}…`);
    const status = await apiClient.getEmbeddingStatus(project.id);
    spinner?.stop();
    if (options.json) {
      printJson({ projectId: project.id, ...status });
      return;
    }
    console.log(chalk.bold.cyan(`pgvector — ${project.name}\n`));
    printStatus(status);
    if (!status.pgvectorEnabled) {
      console.log();
      info('Enable it with:  basefyio pgvector enable');
    }
  } catch (err) {
    spinner?.fail('Could not read the pgvector status');
    await handleApiError(err);
  }
}

// pgvector enable

export async function pgvectorEnable(options: PgvectorOptions) {
  requireLogin();
  let spinner: Ora | null = null;
  try {
    const project = await resolveTargetProject(options.project);
    const before = await apiClient.getEmbeddingStatus(project.id);
    if (before.pgvectorEnabled) {
      if (options.json) printJson({ projectId: project.id, enabled: true, changed: false });
      else info(`pgvector is already enabled on ${chalk.cyan(project.name)}.`);
      return;
    }

    spinner = options.json
      ? null
      : createSpinner(`Enabling pgvector on ${chalk.cyan(project.name)} (extension, embedding tables, indexes)…`);
    await apiClient.enablePgvector(project.id);

    // Report what the platform now says, not what the request implied.
    const after = await apiClient.getEmbeddingStatus(project.id);
    if (!after.pgvectorEnabled) {
      spinner?.fail('The API accepted the request but pgvector is still disabled');
      if (options.json) printJson({ projectId: project.id, enabled: false, changed: false });
      process.exit(1);
    }
    spinner?.succeed(`pgvector enabled on ${chalk.cyan(project.name)}`);
    if (options.json) {
      printJson({ projectId: project.id, enabled: true, changed: true, status: after });
      return;
    }
    console.log();
    printStatus(after);
    if (after.keySource === 'none' && after.requiresApiKey !== false) {
      console.log();
      warning('No embedding API key is configured yet. Add one in the dashboard under AI / Embeddings before storing vectors.');
    }
  } catch (err) {
    spinner?.fail('Enabling pgvector failed');
    await handleApiError(err);
  }
}

// pgvector disable

export async function pgvectorDisable(options: PgvectorDisableOptions) {
  requireLogin();
  let spinner: Ora | null = null;
  try {
    const project = await resolveTargetProject(options.project);
    const before = await apiClient.getEmbeddingStatus(project.id);
    if (!before.pgvectorEnabled && !options.dropData) {
      if (options.json) printJson({ projectId: project.id, enabled: false, changed: false });
      else info(`pgvector is already disabled on ${chalk.cyan(project.name)}.`);
      return;
    }

    if (!options.json) {
      const count = before.embeddingCount;
      console.log(chalk.bold.cyan(`Disable pgvector — ${project.name}\n`));
      console.log('  Embedding API calls for this project will be refused until pgvector is enabled again.');
      if (options.dropData) {
        console.log(
          chalk.yellow(
            `  --drop-data also DELETES the stored embeddings${count != null ? ` (${count} ${count === 1 ? 'vector' : 'vectors'})` : ''}. This cannot be undone.`,
          ),
        );
      } else {
        console.log('  Stored embeddings are kept. Pass --drop-data to delete them as well.');
      }
      console.log();
    }

    const confirmed = await confirmOrExit({
      yes: options.yes,
      action: options.dropData ? 'delete embedding data' : 'disable pgvector',
      message: options.dropData
        ? `This disables pgvector on "${project.name}" and deletes its stored embeddings.`
        : `Disable pgvector on "${project.name}"?`,
      typeName: options.dropData ? project.name : undefined,
    });
    if (!confirmed) return;

    spinner = options.json ? null : createSpinner('Disabling pgvector…');
    const response = await apiClient.disablePgvector(project.id, { dropData: !!options.dropData });
    const after = await apiClient.getEmbeddingStatus(project.id);
    if (after.pgvectorEnabled) {
      spinner?.fail('The API accepted the request but pgvector is still enabled');
      if (options.json) printJson({ projectId: project.id, enabled: true, dataDropped: false });
      process.exit(1);
    }
    spinner?.stop();

    const outcome = describeDisableOutcome(!!options.dropData, response);
    if (options.json) {
      printJson({ projectId: project.id, enabled: false, dataDropped: response?.dataDropped === true });
      if (outcome.level === 'warning') process.exitCode = 1;
      return;
    }
    if (outcome.level === 'success') {
      success(outcome.lines[0]);
      outcome.lines.slice(1).forEach((l) => console.log(`  ${l}`));
    } else {
      warning(outcome.lines[0]);
      outcome.lines.slice(1).forEach((l) => console.log(`  ${l}`));
      // The user asked for a deletion that did not happen: that is a failure.
      process.exitCode = 1;
    }
  } catch (err) {
    spinner?.fail('Disabling pgvector failed');
    await handleApiError(err);
  }
}
