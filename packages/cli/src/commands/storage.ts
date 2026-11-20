import chalk from 'chalk';
import inquirer from 'inquirer';
import { apiClient, handleApiError } from '../lib/api.js';
import { getLocalEnv, getProjectConfig, isLoggedIn } from '../lib/config.js';
import { resolveProjectId } from '../lib/backups.js';
import { createSpinner, error, info, printBox, printJson, printTable, success, warning } from '../lib/ui.js';
import { awsEnvLines, bucketLabel, connectionLines, formatSize, keyRows, validateBucketName } from '../lib/storage.js';

interface CommonOptions {
  project?: string;
  json?: boolean;
}

async function projectId(flag?: string): Promise<string> {
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

export async function storageBuckets(options: CommonOptions) {
  const id = await projectId(options.project);
  const spinner = createSpinner('Fetching buckets…');
  try {
    const buckets = await apiClient.listBuckets(id);
    spinner.stop();
    if (options.json) return printJson(buckets);
    if (!buckets.length) return info('No buckets yet. Create one with:  basefyio storage create-bucket <name>');
    printTable(
      ['Name', 'Public', 'Objects', 'Size'],
      buckets.map((b) => [b.name, b.public ? 'yes' : 'no', String(b.objectCount ?? ''), formatSize(b.totalSize)]),
    );
  } catch (err) {
    spinner.fail('Could not list buckets');
    await handleApiError(err);
  }
}

export async function storageCreateBucket(name: string, options: CommonOptions & { public?: boolean }) {
  const problem = validateBucketName(name);
  if (problem) {
    error(problem);
    process.exit(1);
  }
  const id = await projectId(options.project);
  try {
    const out = await apiClient.createBucket(id, name, options.public === true);
    if (options.json) return printJson(out);
    success(`Bucket ${chalk.cyan(name)} created (${options.public ? 'public' : 'private'})`);
  } catch (err) {
    await handleApiError(err);
  }
}

export async function storageDeleteBucket(name: string, options: CommonOptions & { force?: boolean }) {
  const id = await projectId(options.project);
  if (!options.force) {
    const { ok } = await inquirer.prompt([
      { type: 'confirm', name: 'ok', default: false, message: `Delete bucket "${name}" and every file in it? There is no undo.` },
    ]);
    if (!ok) return info('Nothing deleted');
  }
  try {
    await apiClient.deleteBucket(id, name);
    success(`Bucket ${chalk.cyan(name)} deleted`);
  } catch (err) {
    await handleApiError(err);
  }
}

export async function storageKeys(options: CommonOptions) {
  const id = await projectId(options.project);
  try {
    const keys = await apiClient.listS3Keys(id);
    if (options.json) return printJson(keys);
    if (!keys.length) return info('No S3 access keys. Create one with:  basefyio storage create-key <name>');
    printTable(['ID', 'Name', 'Access key ID', 'Secret', 'Created'], keyRows(keys));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function storageCreateKey(name: string, options: CommonOptions) {
  const id = await projectId(options.project);
  try {
    const created = await apiClient.createS3Key(id, name);
    if (options.json) return printJson(created);
    success(`S3 access key ${chalk.cyan(created.name)} created`);
    printBox(awsEnvLines(created).join('\n'), { title: 'Shown once: store the secret now', borderColor: 'yellow' });
    console.log(chalk.gray('  Path-style addressing (forcePathStyle: true). Buckets this key reaches:'));
    for (const b of created.buckets) console.log(`    ${bucketLabel(b)}`);
    if (!created.buckets.length) console.log(chalk.gray('    none yet: create one with  basefyio storage create-bucket <name>'));
    console.log();
    warning('This key bypasses storage access rules. Use it only on servers you control.');
  } catch (err) {
    await handleApiError(err);
  }
}

export async function storageRevokeKey(keyId: string, options: CommonOptions & { force?: boolean }) {
  const id = await projectId(options.project);
  if (!options.force) {
    const { ok } = await inquirer.prompt([
      { type: 'confirm', name: 'ok', default: false, message: `Revoke S3 key ${keyId}? Clients using it stop working at once.` },
    ]);
    if (!ok) return info('Nothing revoked');
  }
  try {
    await apiClient.revokeS3Key(id, keyId);
    success(`S3 access key ${chalk.cyan(keyId)} revoked`);
  } catch (err) {
    await handleApiError(err);
  }
}

export async function storageStatus(options: CommonOptions) {
  const id = await projectId(options.project);
  try {
    const s3 = await apiClient.getS3Info(id);
    if (options.json) return printJson(s3);
    console.log(chalk.bold('  S3 connection'));
    for (const [label, value] of connectionLines(s3)) console.log(`    ${chalk.gray(label.padEnd(16))} ${value}`);
    console.log();
    console.log(chalk.bold('  Buckets (S3 clients use the name after the arrow)'));
    if (!s3.buckets.length) console.log(chalk.gray('    none'));
    for (const b of s3.buckets) console.log(`    ${bucketLabel(b)}`);
    if (s3.unreachable.length) {
      console.log();
      console.log(chalk.bold('  Not reachable with an S3 key'));
      for (const u of s3.unreachable) console.log(`    ${u.physical}  ${chalk.gray(u.reason)}`);
    }
    console.log();
  } catch (err) {
    await handleApiError(err);
  }
}
