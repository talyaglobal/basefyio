import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { isLoggedIn } from '../lib/config.js';
import { error, success, info, createSpinner, printTable, printHeader } from '../lib/ui.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function requireLogin(): void {
  if (!isLoggedIn()) {
    error('You must be logged in. Run: basefyio login');
    process.exit(1);
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'COMPLETED': return chalk.green(status);
    case 'PENDING':   return chalk.yellow(status);
    case 'RUNNING':   return chalk.cyan(status);
    case 'FAILED':    return chalk.red(status);
    case 'CANCELLED': return chalk.gray(status);
    case 'DRY_RUN':   return chalk.magenta(status);
    default:          return status;
  }
}

// ── operations ───────────────────────────────────────────────────────────────

export async function listOperations(opts: { projectId: string; status?: string; limit?: string }) {
  requireLogin();

  if (!opts.projectId) {
    error('--project-id is required');
    process.exit(1);
  }

  const spinner = createSpinner('Loading operations...');
  try {
    const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
    const ops = await apiClient.listProvisioningOperations(opts.projectId, {
      status: opts.status,
      limit,
    });
    spinner.stop();

    if (!ops || ops.length === 0) {
      info('No operations found');
      return;
    }

    printHeader(`Operations for project ${opts.projectId}`);
    console.log();

    const rows = ops.map((op: any) => [
      chalk.cyan(op.provisioningOperationId ?? op.id ?? '—'),
      statusColor(op.status),
      op.type ?? '—',
      op.dryRun ? chalk.magenta('dry-run') : '',
      new Date(op.createdAt).toLocaleString(),
    ]);

    printTable(['ID', 'Status', 'Type', 'Flags', 'Created'], rows);
    console.log();
    console.log(chalk.gray(`Total: ${ops.length} operation(s)`));
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

export async function getOperation(operationId: string) {
  requireLogin();

  const spinner = createSpinner('Loading operation...');
  try {
    const op = await apiClient.getProvisioningOperation(operationId);
    spinner.stop();

    printHeader(`Operation ${operationId}`);
    console.log();
    console.log(chalk.gray('Status:    '), statusColor(op.status));
    console.log(chalk.gray('Type:      '), op.type ?? '—');
    console.log(chalk.gray('Dry run:   '), op.dryRun ? chalk.magenta('yes') : 'no');
    console.log(chalk.gray('Idem. key: '), op.idempotencyKey ?? '—');
    console.log(chalk.gray('Created:   '), new Date(op.createdAt).toLocaleString());
    if (op.startedAt) console.log(chalk.gray('Started:   '), new Date(op.startedAt).toLocaleString());
    if (op.completedAt) console.log(chalk.gray('Completed: '), new Date(op.completedAt).toLocaleString());
    if (op.error) {
      console.log();
      console.log(chalk.red('Error:'), JSON.stringify(op.error, null, 2));
    }
    if (op.result) {
      console.log();
      console.log(chalk.gray('Result:'), JSON.stringify(op.result, null, 2));
    }
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

export async function cancelOperation(operationId: string) {
  requireLogin();

  const spinner = createSpinner('Cancelling operation...');
  try {
    const op = await apiClient.cancelProvisioningOperation(operationId);
    spinner.stop();
    success(`Operation ${chalk.cyan(operationId)} cancelled`);
    console.log(chalk.gray('Status:'), statusColor(op.status));
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

export async function retryOperation(operationId: string) {
  requireLogin();

  const spinner = createSpinner('Retrying operation...');
  try {
    const op = await apiClient.retryProvisioningOperation(operationId);
    spinner.stop();
    success(`Operation ${chalk.cyan(operationId)} queued for retry`);
    console.log(chalk.gray('Status:'), statusColor(op.status));
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

export async function watchOperation(operationId: string, opts: { intervalSecs?: string } = {}) {
  requireLogin();

  const intervalMs = (opts.intervalSecs ? parseInt(opts.intervalSecs, 10) : 3) * 1000;
  const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL_FAILED']);

  const spinner = createSpinner(`Watching operation ${operationId}…`);
  const start = Date.now();

  try {
    while (true) {
      const op = await apiClient.getProvisioningOperation(operationId);
      const elapsed = Math.round((Date.now() - start) / 1000);

      if (TERMINAL.has(op.status)) {
        spinner.stop();
        if (op.status === 'COMPLETED') {
          success(`Operation ${chalk.cyan(operationId)} → ${statusColor(op.status)} (${elapsed}s)`);
        } else {
          error(`Operation ${chalk.cyan(operationId)} → ${statusColor(op.status)} (${elapsed}s)`);
        }
        if (op.error) console.log(chalk.red('Error:'), JSON.stringify(op.error, null, 2));
        if (op.result) console.log(chalk.gray('Result:'), JSON.stringify(op.result, null, 2));
        return;
      }

      spinner.stop();
      process.stdout.write(`\r${chalk.cyan('●')} ${operationId} — ${statusColor(op.status)} (${elapsed}s)   `);
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

// ── credential refs ───────────────────────────────────────────────────────────

export async function createCredentialRef(opts: {
  teamId: string;
  label: string;
  path: string;
  provider?: string;
}) {
  requireLogin();

  const missing = (['teamId', 'label', 'path'] as const).filter((k) => !opts[k]);
  if (missing.length) {
    error(`Missing required options: ${missing.map((k) => `--${k}`).join(', ')}`);
    process.exit(1);
  }

  const spinner = createSpinner('Creating credential ref...');
  try {
    const ref = await apiClient.createProvisioningCredentialRef({
      teamId: opts.teamId,
      label: opts.label,
      openbaoPath: opts.path,
      provider: opts.provider,
    });
    spinner.stop();
    success(`Credential ref created: ${chalk.cyan(ref.credentialRefId ?? ref.id)}`);
    console.log(chalk.gray('Label:   '), ref.label);
    console.log(chalk.gray('Path:    '), ref.openbaoPath);
    if (ref.provider) console.log(chalk.gray('Provider:'), ref.provider);
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

export async function listCredentialRefs(opts: { teamId: string }) {
  requireLogin();

  if (!opts.teamId) {
    error('--team-id is required');
    process.exit(1);
  }

  const spinner = createSpinner('Loading credential refs...');
  try {
    const refs = await apiClient.listProvisioningCredentialRefs(opts.teamId);
    spinner.stop();

    if (!refs || refs.length === 0) {
      info('No credential refs found');
      console.log(chalk.gray('Create one with: basefyio credentials create --team-id <id> --label <label> --path <path>'));
      return;
    }

    printHeader(`Credential refs for team ${opts.teamId}`);
    console.log();

    const rows = refs.map((ref: any) => [
      chalk.cyan(ref.credentialRefId ?? ref.id ?? '—'),
      ref.label,
      ref.openbaoPath,
      ref.provider ?? '—',
      new Date(ref.createdAt).toLocaleString(),
    ]);

    printTable(['ID', 'Label', 'Path', 'Provider', 'Created'], rows);
    console.log();
    console.log(chalk.gray(`Total: ${refs.length} ref(s)`));
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

export async function logsOperation(operationId: string, opts: { limit?: string; cursor?: string } = {}) {
  requireLogin();

  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
  const spinner = createSpinner('Loading operation events...');
  try {
    const { events, nextCursor } = await apiClient.getProvisioningOperationEvents(operationId, { limit, cursor: opts.cursor });
    spinner.stop();

    if (!events || events.length === 0) {
      info('No events found for this operation');
      return;
    }

    printHeader(`Events for operation ${operationId}`);
    console.log();

    const rows = events.map((ev: any) => [
      new Date(ev.createdAt).toLocaleString(),
      chalk.cyan(ev.kind),
      ev.fromStatus ? `${ev.fromStatus} → ${ev.toStatus}` : (ev.toStatus ?? '—'),
      ev.actorUserId ? chalk.gray(ev.actorUserId.slice(0, 8) + '…') : '—',
    ]);

    printTable(['Time', 'Event', 'Status Change', 'Actor'], rows);
    console.log();
    console.log(chalk.gray(`Total: ${events.length} event(s)`));

    if (nextCursor) {
      console.log();
      console.log(chalk.gray(`More events available — use --cursor ${nextCursor} to fetch the next page.`));
    }
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

export async function revokeCredentialRef(credentialRefId: string) {
  requireLogin();

  const spinner = createSpinner('Revoking credential ref...');
  try {
    await apiClient.revokeProvisioningCredentialRef(credentialRefId);
    spinner.stop();
    success(`Credential ref ${chalk.cyan(credentialRefId)} revoked`);
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

// ── resources ─────────────────────────────────────────────────────────────────

export async function listResources(opts: {
  projectId: string;
  status?: string;
  provider?: string;
  limit?: string;
  cursor?: string;
}) {
  requireLogin();

  const spinner = createSpinner('Loading resources...');
  try {
    const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
    const { items, nextCursor } = await apiClient.listProvisioningResources(opts.projectId, {
      status: opts.status,
      provider: opts.provider,
      limit,
      cursor: opts.cursor,
    });
    spinner.stop();

    if (!items || items.length === 0) {
      info('No resources found');
      return;
    }

    printHeader(`Resources for project ${opts.projectId}`);
    console.log();

    const rows = items.map((r: any) => [
      chalk.cyan(r.id.slice(0, 8) + '…'),
      r.resourceType ?? r.kind ?? '—',
      r.name ?? '—',
      r.status,
      r.externalId ?? '—',
      new Date(r.createdAt).toLocaleString(),
    ]);

    printTable(['ID', 'Type', 'Name', 'Status', 'External ID', 'Created'], rows);
    console.log();
    console.log(chalk.gray(`Total: ${items.length} resource(s)`));

    if (nextCursor) {
      console.log();
      console.log(chalk.gray(`More resources available — use --cursor ${nextCursor} to fetch the next page.`));
    }
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

// ── providers ─────────────────────────────────────────────────────────────────

export async function providersHealth(providerName?: string) {
  requireLogin();

  const spinner = createSpinner('Checking provider health...');
  try {
    if (providerName) {
      const result = await apiClient.getProviderHealth(providerName);
      spinner.stop();
      const { name, healthy, latencyMs, checkedAt } = result;
      const status = healthy ? chalk.green('✓ healthy') : chalk.red('✗ unhealthy');
      console.log(`${chalk.cyan(name)}: ${status}  latency=${latencyMs != null ? latencyMs : 'N/A'}ms  checked=${checkedAt}`);
    } else {
      const result = await apiClient.getAllProviderHealth();
      spinner.stop();
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}

export async function getResource(resourceId: string) {
  requireLogin();

  const spinner = createSpinner('Loading resource...');
  try {
    const r = await apiClient.getProvisioningResource(resourceId);
    spinner.stop();

    printHeader(`Resource ${resourceId}`);
    console.log();
    console.log(chalk.gray('ID:          '), chalk.cyan(r.id));
    console.log(chalk.gray('Type:        '), r.resourceType ?? r.kind ?? '—');
    console.log(chalk.gray('Name:        '), r.name ?? '—');
    console.log(chalk.gray('Status:      '), r.status);
    console.log(chalk.gray('Provider:    '), r.provider ?? '—');
    console.log(chalk.gray('Project ID:  '), r.projectId ?? '—');
    console.log(chalk.gray('External ID: '), r.externalId ?? '—');
    if (r.actualSpec) {
      console.log();
      console.log(chalk.gray('Actual spec:'), JSON.stringify(r.actualSpec, null, 2));
    }
    if (r.desiredSpec) {
      console.log();
      console.log(chalk.gray('Desired spec:'), JSON.stringify(r.desiredSpec, null, 2));
    }
    console.log();
    console.log(chalk.gray('Created:  '), new Date(r.createdAt).toLocaleString());
    console.log(chalk.gray('Updated:  '), new Date(r.updatedAt).toLocaleString());
    if (r.destroyedAt) {
      console.log(chalk.gray('Destroyed:'), new Date(r.destroyedAt).toLocaleString());
    }
  } catch (err: any) {
    spinner.stop();
    await handleApiError(err);
  }
}
