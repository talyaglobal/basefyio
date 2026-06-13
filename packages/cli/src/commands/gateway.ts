import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { printKeyValue } from '../lib/ui.js';

// ── Gateway-specific error normalization ──────────────────────────────────────
//
// Intercepts known gateway HTTP error codes before delegating to the generic
// handleApiError handler. Surfaces actionable hints instead of raw API messages.

function isAxiosLike(err: unknown): err is {
  response?: { status: number; data?: { message?: string } };
  request?: unknown;
} {
  return typeof err === 'object' && err !== null && ('response' in err || 'request' in err);
}

export async function handleGatewayError(err: unknown, certId?: string): Promise<never> {
  if (isAxiosLike(err) && err.response) {
    const { status } = err.response;
    const msg: string = err.response.data?.message ?? '';

    if (status === 403) {
      if (/expired/i.test(msg)) {
        console.error(chalk.red(`Certificate has expired${certId ? ` (${certId})` : ''}`));
        console.error(chalk.yellow(`  Hint: basefyio certs renew ${certId ?? '<certId>'}`));
        process.exit(1);
      }
      if (/revoked/i.test(msg)) {
        console.error(chalk.red(`Certificate has been revoked${certId ? ` (${certId})` : ''}`));
        console.error(chalk.yellow('  Hint: basefyio certs issue — get a new certificate'));
        process.exit(1);
      }
      if (/read.?only/i.test(msg) || /READ-only/i.test(msg)) {
        console.error(chalk.red('Certificate is READ-only — mutating queries are not permitted'));
        console.error(chalk.yellow('  Hint: basefyio certs issue --access-level READ_WRITE'));
        process.exit(1);
      }
    }

    if (status === 503) {
      console.error(chalk.red('OpenBao PKI temporarily unavailable'));
      console.error(chalk.yellow('  Try again in a few minutes. Contact your admin if the issue persists.'));
      process.exit(1);
    }

    if (status === 408) {
      console.error(chalk.red('Gateway query timed out'));
      console.error(chalk.yellow('  Add a LIMIT clause or break the query into smaller batches.'));
      process.exit(1);
    }

    if (status === 413) {
      console.error(chalk.red('Query result too large'));
      console.error(chalk.yellow('  Add a LIMIT clause to reduce the result set.'));
      process.exit(1);
    }
  }

  return handleApiError(err);
}

// ── gateway connect ───────────────────────────────────────────────────────────

export async function gatewayConnect(
  projectId: string,
  certId: string,
): Promise<void> {
  try {
    const result = await apiClient.gatewayConnect(projectId, certId);

    console.log(chalk.green('✓ Gateway connection verified'));
    console.log();
    console.log(chalk.bold('Certificate'));
    printKeyValue({
      'Cert ID': result.certId,
      'Access level': result.accessLevel,
      'Status': result.status,
    });

    console.log();
    console.log(chalk.bold('Connection policy'));
    printKeyValue({
      'Requires mTLS': result.policy.requireMtls,
      'Allowed access': result.policy.allowedAccess,
      'Max connections': result.policy.maxConnections,
      'Query timeout': `${result.policy.queryTimeoutMs}ms`,
      'Row limit': result.policy.maxRowLimit.toLocaleString(),
      'Max payload': `${(result.policy.maxPayloadBytes / (1024 * 1024)).toFixed(0)} MB`,
      'Provider': result.policy.providerType,
    });
  } catch (err) {
    await handleGatewayError(err, certId);
  }
}

// ── gateway query ─────────────────────────────────────────────────────────────

export async function gatewayQuery(
  projectId: string,
  certId: string,
  sql: string,
): Promise<void> {
  try {
    const result = await apiClient.gatewayQuery(projectId, certId, sql);

    if (result.truncated) {
      console.log(chalk.yellow(`⚠  Result truncated — showing first ${result.rows.length} of ${result.rowCount} rows`));
    }

    if (result.rows.length === 0) {
      console.log(chalk.gray('No rows returned.'));
      return;
    }

    // Print as aligned table
    const cols = Object.keys(result.rows[0]);
    const widths = cols.map((col) =>
      Math.max(col.length, ...result.rows.map((r) => String(r[col] ?? '').length)),
    );

    const header = cols.map((col, i) => col.padEnd(widths[i])).join('  ');
    const divider = widths.map((w) => '-'.repeat(w)).join('  ');

    console.log(chalk.bold(header));
    console.log(chalk.gray(divider));
    for (const row of result.rows) {
      console.log(cols.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join('  '));
    }

    console.log();
    console.log(chalk.gray(`${result.rows.length} row(s)${result.truncated ? ' (truncated)' : ''}`));
  } catch (err) {
    await handleGatewayError(err, certId);
  }
}

// ── gateway health ────────────────────────────────────────────────────────────

export async function gatewayHealth(): Promise<void> {
  try {
    const report = await apiClient.gatewayHealth();

    const statusColor =
      report.status === 'healthy' ? chalk.green
      : report.status === 'degraded' ? chalk.yellow
      : chalk.red;

    console.log(chalk.bold('OpenBao Health'));
    console.log(chalk.gray('─'.repeat(44)));
    console.log(`Status:     ${statusColor(report.status)}`);
    console.log(`Checked at: ${chalk.gray(report.checkedAt)}`);
    console.log();

    // Component table
    const components: Array<[string, { status: string; detail?: string; hint?: string }]> = [
      ['system', report.components.system],
      ['pkiMount', report.components.pkiMount],
      ['kvMount', report.components.kvMount],
    ];

    const labelW = 12;
    const statusW = 11;
    console.log(
      chalk.bold('Component'.padEnd(labelW) + 'Status'.padEnd(statusW) + 'Detail'),
    );
    console.log(chalk.gray('─'.repeat(labelW) + '─'.repeat(statusW) + '─'.repeat(24)));

    const hints: string[] = [];
    for (const [name, comp] of components) {
      const compColor =
        comp.status === 'ok' ? chalk.green
        : comp.status === 'degraded' ? chalk.yellow
        : chalk.red;
      console.log(
        name.padEnd(labelW) +
        compColor(comp.status.padEnd(statusW)) +
        chalk.gray(comp.detail ?? ''),
      );
      if (comp.hint) hints.push(`  ${chalk.bold(name)}: ${comp.hint}`);
    }

    if (hints.length > 0) {
      console.log();
      console.log(chalk.bold('Hints'));
      hints.forEach((h) => console.log(h));
    }
  } catch (err) {
    await handleGatewayError(err);
  }
}

// ── gateway policy ────────────────────────────────────────────────────────────

export async function gatewayPolicy(projectId: string): Promise<void> {
  try {
    const policy = await apiClient.gatewayPolicy(projectId);

    console.log(chalk.bold('Gateway policy  ' + chalk.gray('(' + projectId + ')')));
    console.log();
    printKeyValue({
      'Requires mTLS': policy.requireMtls,
      'Allowed access': policy.allowedAccess,
      'Max connections': policy.maxConnections,
      'Query timeout': `${policy.queryTimeoutMs}ms`,
      'Row limit': policy.maxRowLimit.toLocaleString(),
      'Max payload': `${(policy.maxPayloadBytes / (1024 * 1024)).toFixed(0)} MB`,
      'Provider': policy.providerType,
    });
  } catch (err) {
    await handleGatewayError(err);
  }
}
