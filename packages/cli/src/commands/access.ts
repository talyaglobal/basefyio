import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { info, printKeyValue } from '../lib/ui.js';

// ── Developer Access ──────────────────────────────────────────

export async function projectAccess(projectId: string): Promise<void> {
  try {
    const result = await apiClient.getProjectAccess(projectId);

    if (result.warning) {
      console.log(chalk.yellow('⚠  ' + result.warning));
    }

    console.log(chalk.bold('Project: ' + result.slug + '  (' + result.projectId + ')'));

    if (result.endpoints.length === 0) {
      info('No endpoints provisioned yet.');
      return;
    }

    for (const endpoint of result.endpoints) {
      console.log();
      console.log(chalk.bold(endpoint.engineType.toUpperCase() + ' endpoint'));

      printKeyValue({
        'Host': endpoint.host,
        'Port': endpoint.port,
        'Username': endpoint.username,
        'Database': endpoint.database,
        'Access level': endpoint.accessLevel,
        'Client cert required': endpoint.requiresClientCert,
        'SSL mode': endpoint.sslMode,
      });

      console.log();
      console.log(chalk.bold('Connection string:'));
      console.log(chalk.gray('  ' + endpoint.connectionString));

      const snippets = endpoint.snippets;
      if (snippets && Object.keys(snippets).length > 0) {
        console.log();
        console.log(chalk.bold('Snippets:'));
        for (const [label, value] of Object.entries(snippets)) {
          if (value) {
            console.log(chalk.gray('  ' + label + ':  ' + value));
          }
        }
      }
    }

    console.log();
    console.log(chalk.bold('Entitlements:'));
    printKeyValue(
      Object.fromEntries(
        Object.entries(result.entitlements).map(([k, v]) => [
          k,
          v ? chalk.green('✓') : chalk.red('✗'),
        ]),
      ),
    );
  } catch (err) {
    await handleApiError(err);
  }
}
