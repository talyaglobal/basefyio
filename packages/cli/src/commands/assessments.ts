import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig } from '../lib/config.js';
import { error, success, info, printTable } from '../lib/ui.js';

// ── assessments assess ───────────────────────────────────────

export async function assessArchive(archiveId: string): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  console.log(chalk.cyan('Running assessment…'));

  try {
    const version = await apiClient.createAssessment(config.projectId, archiveId);

    console.log();
    console.log(chalk.bold('Assessment triggered'));
    console.log(`  Report ID  : ${version.reportId ?? '-'}`);
    console.log(`  Version    : ${version.version ?? '-'}`);
    console.log(`  Status     : ${version.status ?? '-'}`);
    if (version.confidencePct != null)
      console.log(`  Confidence : ${version.confidencePct}%`);
    if (version.complexity != null)
      console.log(`  Complexity : ${version.complexity}`);
    if (version.riskLevel != null)
      console.log(`  Risk       : ${version.riskLevel}`);
    if (version.estimatedCostCents != null)
      console.log(`  Est. cost  : $${(version.estimatedCostCents / 100).toFixed(2)}`);
    if (version.estimatedDurationDays != null)
      console.log(`  Est. days  : ${version.estimatedDurationDays}`);
  } catch (err) {
    await handleApiError(err);
  }
}

// ── assessments list ─────────────────────────────────────────

export async function listAssessments(): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  try {
    const reports = await apiClient.listAssessments(config.projectId);

    if (!Array.isArray(reports) || !reports.length) {
      info('No assessment reports found — use: basefyio assessments assess <archiveId>');
      return;
    }

    const rows = reports.map((r: any) => [
      r.id ?? '',
      r.archiveId ?? '',
      r.status ?? '',
      String(r.latestVersion ?? ''),
      r.createdAt ?? '',
    ]);

    printTable(['reportId', 'archiveId', 'status', 'latestVersion', 'createdAt'], rows);
  } catch (err) {
    await handleApiError(err);
  }
}

// ── assessments get ──────────────────────────────────────────

export async function getAssessment(reportId: string): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  try {
    const versions = await apiClient.getAssessmentVersions(config.projectId, reportId);

    if (!Array.isArray(versions) || !versions.length) {
      info('No versions found for this report.');
      return;
    }

    // Sort by version descending and take the latest
    const sorted = [...versions].sort((a: any, b: any) => (b.version ?? 0) - (a.version ?? 0));
    const latest = sorted[0] as any;

    console.log();
    console.log(chalk.bold(`Assessment Report: ${reportId}`));
    console.log(`  Version    : ${latest.version ?? '-'}`);
    console.log(`  Status     : ${latest.status ?? '-'}`);
    if (latest.tablesFound != null)
      console.log(`  Tables     : ${latest.tablesFound}`);
    if (latest.recordsFound != null)
      console.log(`  Records    : ${latest.recordsFound}`);
    if (latest.sizeBytes != null)
      console.log(`  Size       : ${latest.sizeBytes} bytes`);
    if (latest.confidencePct != null)
      console.log(`  Confidence : ${latest.confidencePct}%`);
    if (latest.complexity != null)
      console.log(`  Complexity : ${latest.complexity}`);
    if (latest.riskLevel != null)
      console.log(`  Risk       : ${latest.riskLevel}`);
    if (latest.estimatedCostCents != null)
      console.log(`  Est. cost  : $${(latest.estimatedCostCents / 100).toFixed(2)}`);
    if (latest.estimatedDurationDays != null)
      console.log(`  Est. days  : ${latest.estimatedDurationDays}`);
    if (latest.humanInvolvementPct != null)
      console.log(`  Human inv. : ${latest.humanInvolvementPct}%`);
    if (latest.dataLossRiskPct != null)
      console.log(`  Data loss  : ${latest.dataLossRiskPct}%`);
    if (latest.errorMessage)
      console.log(chalk.red(`  Error      : ${latest.errorMessage}`));

    const findings: any[] = Array.isArray(latest.findings) ? latest.findings : [];
    if (findings.length) {
      console.log();
      console.log(chalk.bold('Findings:'));
      const findingRows = findings.map((f: any) => [
        f.category ?? '',
        f.title ?? '',
        f.riskLevel ?? '',
        f.detail ?? '',
      ]);
      printTable(['category', 'title', 'riskLevel', 'detail'], findingRows);
    } else {
      console.log();
      info('No findings recorded for this version.');
    }
  } catch (err) {
    await handleApiError(err);
  }
}

// ── assessments export-pdf ───────────────────────────────────

export async function exportAssessmentPdf(reportId: string, versionId?: string): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  try {
    const result = await apiClient.exportAssessmentPdf(config.projectId, reportId, versionId);
    success(`PDF export queued`);
    console.log(`  Export Job ID : ${result.exportJobId ?? '-'}`);
    console.log(`  Status        : ${result.status ?? '-'}`);
    if (result.message)
      console.log(`  Message       : ${result.message}`);
  } catch (err) {
    await handleApiError(err);
  }
}
