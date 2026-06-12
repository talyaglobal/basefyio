import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig } from '../lib/config.js';
import { error, success, info, warning, printBox, printTable } from '../lib/ui.js';

// ── archives create ──────────────────────────────────────────

export async function createArchive(source: string, region: string): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  try {
    const archive = await apiClient.createMigrationArchive(config.projectId, { source, region });
    success(`Archive created — ID: ${archive.id}  region: ${archive.region}  status: ${archive.status}`);
  } catch (err) {
    await handleApiError(err);
  }
}

// ── archives files ───────────────────────────────────────────

export async function listArchiveFiles(archiveId: string): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  try {
    const files = await apiClient.listArchiveFiles(config.projectId, archiveId);

    if (!files.length) {
      info('No files in this archive yet — use: basefyio archives upload');
      return;
    }

    const rows = files.map((f: any) => [
      f.filename ?? '',
      f.status ?? '',
      String(f.uploadedBytes ?? ''),
      String(f.sizeBytes ?? ''),
      f.resumeToken ?? '',
    ]);

    printTable(['filename', 'status', 'uploadedBytes', 'sizeBytes', 'resumeToken'], rows);
  } catch (err) {
    await handleApiError(err);
  }
}

// ── archives consent ─────────────────────────────────────────

export async function archiveConsent(archiveId: string): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  printBox(
    `You are about to record consent for migration archive ${archiveId}`,
    { title: 'Consent Required', borderColor: 'yellow' },
  );

  console.log(chalk.bold('Required consent items:'));
  console.log(`  ${chalk.green('[✓]')}  Privacy statement`);
  console.log(`  ${chalk.green('[✓]')}  Data ownership`);
  console.log(`  ${chalk.green('[✓]')}  AI analysis consent`);
  console.log(`  ${chalk.green('[✓]')}  Migration risk acceptance`);
  console.log(`  ${chalk.green('[✓]')}  Database access authorization`);
  console.log();

  try {
    await apiClient.recordConsent(config.projectId, archiveId, {
      ipAddress: '0.0.0.0',
      privacyStatementVersion: 'v1.0',
      riskStatementVersion: 'v1.0',
      archivePolicyVersion: 'v1.0',
      acceptedItems: [
        'privacy_statement',
        'data_ownership',
        'ai_analysis_consent',
        'migration_risk_acceptance',
        'database_access_authorization',
      ],
      sensitiveDataFlags: {},
      dbAccessAuthorized: false,
    });
    success('Consent recorded — migration can now proceed');
  } catch (err) {
    await handleApiError(err);
  }
}

// ── archives delete ──────────────────────────────────────────

export async function deleteArchive(archiveId: string): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  console.log(chalk.red(`WARNING: This will permanently delete archive ${archiveId} and stop billing.`));
  console.log();

  try {
    await apiClient.deleteMigrationArchive(config.projectId, archiveId);
    success('Archive deleted');
  } catch (err) {
    await handleApiError(err);
  }
}
