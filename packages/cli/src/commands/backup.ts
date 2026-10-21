import chalk from 'chalk';
import inquirer from 'inquirer';
import fs from 'fs/promises';
import path from 'path';
import type { Ora } from 'ora';
import { apiClient, handleApiError } from '../lib/api.js';
import { getLocalEnv, getProjectConfig, isLoggedIn } from '../lib/config.js';
import { createSpinner, error, info, printBox, printJson, printTable, success, warning } from '../lib/ui.js';
import {
  buildRestoreBody,
  defaultArchiveName,
  describeRestoreEffects,
  formatBytes,
  isLocalArchive,
  LARGE_ARCHIVE_WARN_BYTES,
  pollExportJob,
  resolveBackupRef,
  resolveProjectId,
  type ArchiveImportResult,
  type CloudBackupEntry,
  type ExportJobProgress,
  type RestorePlan,
} from '../lib/backups.js';

interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  teamId: string;
}

// Shared

function requireLogin(): void {
  if (!isLoggedIn()) {
    error('Not logged in. Run:  basefyio login');
    process.exit(1);
  }
}

/** The project a command acts on: `--project`, else the linked project, else `BASEFYIO_PROJECT_ID` in .env. */
async function resolveProject(flag?: string): Promise<ProjectSummary> {
  const [config, env] = await Promise.all([getProjectConfig(), getLocalEnv()]);
  let projectId: string;
  try {
    projectId = resolveProjectId({ flag, config, env });
  } catch (err: any) {
    error(err.message);
    process.exit(1);
  }
  const project = await apiClient.getProject(projectId);
  return { id: project.id, name: project.name, slug: project.slug, teamId: project.teamId };
}

function parseTimeoutMinutes(raw?: string): number {
  if (raw === undefined) return 60;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    error('--timeout must be a positive number of minutes');
    process.exit(1);
  }
  return n;
}

/**
 * Where to write an archive. An explicit `--out` may overwrite; a generated
 * name never does, so two backups taken in the same second cannot clobber each other.
 */
async function resolveOutPath(out: string | undefined, fallbackName: string): Promise<string> {
  if (out) return path.resolve(out);
  const target = path.resolve(fallbackName);
  try {
    await fs.access(target);
  } catch {
    return target;
  }
  error(`${target} already exists. Pass --out <file> to choose another name.`);
  process.exit(1);
}

function progressText(p: ExportJobProgress): string {
  const detail = p.detail ? ` — ${p.detail}` : '';
  const percent = typeof p.percent === 'number' ? ` (${p.percent}%)` : '';
  return `${p.step}${detail}${percent}`;
}

async function downloadWithSpinner(
  spinner: Ora | null,
  projectId: string,
  jobId: string,
  outPath: string,
): Promise<number> {
  const { bytes } = await apiClient.downloadExportToFile(projectId, jobId, outPath, (received, total) => {
    if (!spinner) return;
    spinner.text = total
      ? `Downloading… ${formatBytes(received)} / ${formatBytes(total)}`
      : `Downloading… ${formatBytes(received)}`;
  });
  return bytes;
}

// backup create

export interface BackupCreateOptions {
  out?: string;
  wait?: boolean;
  skipDatabase?: boolean;
  skipAuth?: boolean;
  skipStorage?: boolean;
  skipConfig?: boolean;
  project?: string;
  timeout?: string;
  json?: boolean;
}

export async function backupCreate(options: BackupCreateOptions) {
  requireLogin();
  if (!options.json) console.log(chalk.bold.cyan('Create Backup\n'));
  const timeoutMs = parseTimeoutMinutes(options.timeout) * 60_000;

  let spinner: Ora | null = null;
  try {
    const project = await resolveProject(options.project);
    const body = {
      includeDatabase: !options.skipDatabase,
      includeAuth: !options.skipAuth,
      includeStorage: !options.skipStorage,
      includeConfig: !options.skipConfig,
    };

    spinner = options.json ? null : createSpinner(`Starting export of ${chalk.cyan(project.name)}…`);
    const { jobId } = await apiClient.startExport(project.id, body);

    if (options.wait === false) {
      spinner?.succeed(`Export job ${chalk.cyan(jobId)} started`);
      if (options.json) {
        printJson({ jobId, projectId: project.id });
      } else {
        console.log();
        info(`Check progress:    basefyio backup status ${jobId}`);
        info(`Download when done: basefyio backup download ${jobId}`);
        console.log(chalk.gray('  Finished exports stay on the server for 24 hours.'));
      }
      return;
    }

    if (spinner) spinner.text = `Export job ${jobId} — waiting for the server…`;
    const result = await pollExportJob(() => apiClient.getExportJobStatus(project.id, jobId), {
      timeoutMs,
      onProgress: (p) => {
        if (spinner) spinner.text = progressText(p);
      },
    });

    const outPath = await resolveOutPath(options.out, defaultArchiveName(project.slug));
    if (spinner) spinner.text = `Downloading ${result.filename}…`;
    const bytes = await downloadWithSpinner(spinner, project.id, jobId, outPath);
    spinner?.succeed(`Backup saved to ${chalk.cyan(outPath)} (${formatBytes(bytes)})`);
    spinner = null;

    const sizeMismatch = result.size > 0 && bytes !== result.size;
    if (sizeMismatch) {
      warning(
        `Downloaded ${bytes} bytes but the export reports ${result.size} — check the archive before relying on it.`,
      );
      process.exitCode = 1;
    }

    if (options.json) {
      printJson({ jobId, projectId: project.id, file: outPath, bytes, sizeMismatch, result });
    } else {
      console.log();
      console.log(chalk.gray('  The server copy of this export expires in 24 hours.'));
      console.log(chalk.gray('  Cloud backups (daily automatic + manual):  basefyio backup list'));
    }
  } catch (err) {
    spinner?.fail('Backup failed');
    await handleApiError(err);
  }
}

// backup list

export interface BackupListOptions {
  project?: string;
  kind?: string;
  json?: boolean;
}

export async function backupList(options: BackupListOptions) {
  requireLogin();
  const kind = (options.kind ?? 'all').toLowerCase();
  if (!['all', 'auto', 'manual'].includes(kind)) {
    error('--kind must be auto, manual or all');
    process.exit(1);
  }

  const spinner = options.json ? null : createSpinner('Loading cloud backups…');
  try {
    const project = await resolveProject(options.project);
    const all = await apiClient.listBackups(project.id);
    const entries = all
      .filter((e) => kind === 'all' || e.kind === kind)
      .sort((a, b) => (a.lastModified < b.lastModified ? 1 : a.lastModified > b.lastModified ? -1 : 0));
    spinner?.stop();

    if (options.json) {
      printJson(entries);
      return;
    }

    console.log(chalk.bold.cyan(`Cloud backups — ${project.name}\n`));
    if (!entries.length) {
      info(kind === 'all' ? 'No cloud backups yet.' : `No ${kind} backups yet.`);
      console.log(chalk.gray('  Take one now:  basefyio backup create'));
      return;
    }

    printTable(
      ['#', 'Kind', 'Filename', 'Size', 'Created', 'Object key'],
      entries.map((e, i) => [
        `#${i + 1}`,
        e.kind,
        e.filename,
        formatBytes(e.size),
        new Date(e.lastModified).toLocaleString(),
        e.objectKey,
      ]),
    );

    const autoCount = entries.filter((e) => e.kind === 'auto').length;
    console.log();
    console.log(
      chalk.gray(
        `  ${entries.length} backup(s) — ${autoCount} automatic (kept 7 days), ${entries.length - autoCount} manual (kept 24 hours)`,
      ),
    );
    console.log(chalk.gray('  Restore one:   basefyio restore <#n | filename | object key | latest[:auto|:manual]>'));
  } catch (err) {
    spinner?.fail('Failed to load backups');
    await handleApiError(err);
  }
}

// backup status

export interface BackupStatusOptions {
  project?: string;
  json?: boolean;
}

export async function backupStatus(jobId: string, options: BackupStatusOptions) {
  requireLogin();
  try {
    const project = await resolveProject(options.project);
    const status = await apiClient.getExportJobStatus(project.id, jobId);

    if (!status || status.error) {
      error(status?.error || 'Export job not found (finished jobs are kept for 24 hours)');
      process.exit(1);
    }

    if (options.json) {
      printJson(status);
      return;
    }

    console.log(chalk.bold.cyan(`Export job ${jobId}\n`));
    console.log(`  ${chalk.gray('State')}     ${stateBadge(status.state)}`);
    if (status.progress && typeof status.progress === 'object') {
      console.log(`  ${chalk.gray('Progress')}  ${progressText(status.progress)}`);
    }
    if (status.state === 'completed' && status.result) {
      console.log(`  ${chalk.gray('Archive')}   ${status.result.filename} (${formatBytes(status.result.size)})`);
      console.log();
      console.log(chalk.gray(`  Download it:  basefyio backup download ${jobId}`));
    }
    if (status.state === 'failed') {
      console.log(`  ${chalk.gray('Reason')}    ${chalk.red(status.failedReason || 'unknown')}`);
    }
  } catch (err) {
    await handleApiError(err);
  }
}

function stateBadge(state: string): string {
  switch (state) {
    case 'completed':
      return chalk.green(state);
    case 'failed':
      return chalk.red(state);
    case 'active':
      return chalk.cyan(state);
    default:
      return chalk.yellow(state);
  }
}

// backup download

export interface BackupDownloadOptions {
  project?: string;
  out?: string;
}

export async function backupDownload(jobId: string, options: BackupDownloadOptions) {
  requireLogin();
  console.log(chalk.bold.cyan('Download Backup\n'));

  let spinner: Ora | null = null;
  try {
    const project = await resolveProject(options.project);
    const status = await apiClient.getExportJobStatus(project.id, jobId);
    if (!status || status.error) {
      error(status?.error || 'Export job not found (finished jobs are kept for 24 hours)');
      process.exit(1);
    }
    if (status.state !== 'completed') {
      error(
        status.state === 'failed'
          ? `Export job failed: ${status.failedReason || 'unknown reason'}`
          : `Export job is still ${status.state}. Check again with:  basefyio backup status ${jobId}`,
      );
      process.exit(1);
    }

    const outPath = await resolveOutPath(options.out, status.result?.filename || defaultArchiveName(project.slug));
    spinner = createSpinner('Downloading…');
    const bytes = await downloadWithSpinner(spinner, project.id, jobId, outPath);
    spinner.succeed(`Backup saved to ${chalk.cyan(outPath)} (${formatBytes(bytes)})`);
    spinner = null;

    if (status.result?.size && bytes !== status.result.size) {
      warning(
        `Downloaded ${bytes} bytes but the export reports ${status.result.size} — check the archive before relying on it.`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    spinner?.fail('Download failed');
    await handleApiError(err);
  }
}

// restore

export interface RestoreOptions {
  project?: string;
  newProject?: string;
  team?: string;
  yes?: boolean;
  json?: boolean;
}

type RestoreSource =
  | { kind: 'local'; file: string; size: number }
  | { kind: 'cloud'; entry: CloudBackupEntry };

export async function restoreCommand(target: string, options: RestoreOptions) {
  requireLogin();
  if (!options.json) console.log(chalk.bold.cyan('Restore\n'));

  let spinner: Ora | null = null;
  try {
    // Source
    let source: RestoreSource;
    const local = await isLocalArchive(target);

    // Target
    let plan: RestorePlan;
    let project: ProjectSummary | null = null;
    const newName = options.newProject?.trim();

    if (local) {
      const stat = await fs.stat(target);
      source = { kind: 'local', file: path.resolve(target), size: stat.size };
      if (newName && options.team?.trim()) {
        // A new project in an explicitly named team needs no existing project.
        plan = { mode: 'new', name: newName, teamId: options.team.trim() };
      } else {
        project = await resolveProject(options.project);
        plan = newName
          ? { mode: 'new', name: newName, teamId: options.team?.trim() || project.teamId }
          : { mode: 'existing', projectId: project.id, teamId: project.teamId, projectName: project.name };
      }
    } else {
      project = await resolveProject(options.project);
      const entries = await apiClient.listBackups(project.id);
      let entry: CloudBackupEntry;
      try {
        entry = resolveBackupRef(entries, target);
      } catch (err: any) {
        error(err.message);
        console.log(chalk.gray('  A local archive must be an existing .zip file.'));
        process.exit(1);
      }
      source = { kind: 'cloud', entry };
      plan = newName
        ? { mode: 'new', name: newName, teamId: options.team?.trim() || project.teamId }
        : { mode: 'existing', projectId: project.id, teamId: project.teamId, projectName: project.name };
    }

    // Plan
    const sourceLine =
      source.kind === 'local'
        ? `Source: ${source.file} (${formatBytes(source.size)})`
        : `Source: cloud backup ${source.entry.filename} (${source.entry.kind}, ${new Date(source.entry.lastModified).toLocaleString()}, ${formatBytes(source.entry.size)})\n        ${source.entry.objectKey}`;
    const lines = [sourceLine, ...describeRestoreEffects(plan)];
    if (!options.json) {
      printBox(lines.join('\n'), { title: 'Restore plan', borderColor: plan.mode === 'existing' ? 'yellow' : 'cyan' });
    }

    if (source.kind === 'local' && source.size > LARGE_ARCHIVE_WARN_BYTES) {
      warning(
        `This archive is ${formatBytes(source.size)}. The server holds an uploaded archive in memory while it restores it; ` +
          'for archives this large prefer restoring a cloud backup (basefyio backup list), which never leaves the server.',
      );
    }

    // Confirm
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        error('Refusing to restore without --yes in a non-interactive session.');
        process.exit(1);
      }
      if (plan.mode === 'existing') {
        const name = plan.projectName ?? plan.projectId;
        const { typed } = await inquirer.prompt([
          {
            type: 'input',
            name: 'typed',
            message: `This replaces data in "${name}". Type the project name to confirm:`,
          },
        ]);
        if (typed !== name) {
          info('Restore cancelled — the name did not match.');
          return;
        }
      } else {
        const { confirm } = await inquirer.prompt([
          { type: 'confirm', name: 'confirm', message: `Create "${plan.name}" from this backup?`, default: false },
        ]);
        if (!confirm) {
          info('Restore cancelled');
          return;
        }
      }
    }

    // Execute
    spinner = options.json ? null : createSpinner('Restoring… this can take several minutes');
    let result: ArchiveImportResult;
    if (source.kind === 'local') {
      const fields = buildRestoreBody(plan);
      result = await apiClient.importArchive(source.file, fields, (sent, total) => {
        if (!spinner) return;
        spinner.text =
          total && sent >= total
            ? 'Archive uploaded — restoring on the server… this can take several minutes'
            : `Uploading archive… ${formatBytes(sent)}${total ? ` / ${formatBytes(total)}` : ''}`;
      });
    } else {
      const fields = buildRestoreBody(plan, { objectKey: source.entry.objectKey, kind: source.entry.kind });
      result = await apiClient.restoreCloudBackup(project!.id, fields);
    }
    spinner?.succeed('Restore finished');
    spinner = null;

    // Report
    if (options.json) {
      printJson(result);
      return;
    }
    console.log();
    console.log(`  ${chalk.gray('Project')}  ${chalk.cyan(result.project.name)}  ${chalk.gray(result.project.id)}`);
    console.log(`  ${chalk.gray('Slug')}     ${result.project.slug}`);
    if (result.importedName && result.importedName !== result.appliedName) {
      console.log(`  ${chalk.gray('Archive of')} ${result.importedName}`);
    }
    for (const w of result.warnings ?? []) {
      warning(w);
    }
    console.log();
    success('Restore request completed.');
    console.log(
      chalk.gray(
        '  The server applies the database dump statement by statement and does not stop at the first failing one,\n' +
          '  so a partially applied dump is not reported as a failure. Verify the data:  basefyio inspect',
      ),
    );
  } catch (err) {
    spinner?.fail('Restore failed');
    await handleApiError(err);
  }
}
