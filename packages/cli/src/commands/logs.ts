import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig, isLoggedIn } from '../lib/config.js';
import { error, printHeader, createSpinner } from '../lib/ui.js';

interface LogsOptions {
  tail?: string;
}

export async function logsCommand(options: LogsOptions) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  basefyio link  or  basefyio init');
    process.exit(1);
  }

  if (!isLoggedIn()) {
    error('Not logged in. Run:  basefyio login');
    process.exit(1);
  }

  const limit = parseInt(options.tail || '50', 10);

  const spinner = createSpinner('Fetching SQL audit logs…');

  try {
    const result = await apiClient.executeSQL(
      config.projectId!,
      `SELECT 1`, // quick connectivity test
    );
  } catch {
    // If SQL endpoint fails we try a direct query via project info
  }

  try {
    // The audit logs live in the platform DB, not the project DB.
    // We'll expose them via the existing SQL endpoint against the project.
    // For now, show the last N entries from the API (requires a future endpoint).

    // Fallback: connect directly to the platform database
    const { Pool } = await import('pg');
    const { getLocalEnv } = await import('../lib/config.js');
    const env = await getLocalEnv();

    // Platform DB is the same host but database 'basefyio'
    const host = env.DB_HOST || 'localhost';
    const port = env.DB_PORT || '5432';
    const platformUrl = `postgresql://basefyio:basefyio_secret@${host}:${port}/basefyio`;

    const pool = new Pool({ connectionString: platformUrl });
    const client = await pool.connect();

    try {
      const { rows } = await client.query(
        `SELECT created_at, user_id, query, row_count, duration, error
         FROM sql_audit_logs
         WHERE project_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [config.projectId, limit],
      );

      spinner.stop();

      if (!rows.length) {
        console.log(chalk.gray('  No SQL logs yet for this project.'));
        return;
      }

      printHeader('SQL Audit Logs');
      console.log();

      // Show oldest first
      rows.reverse().forEach((r: any) => {
        const ts = new Date(r.created_at).toLocaleString();
        const dur = r.duration != null ? `${r.duration}ms` : '';
        const badge = r.error
          ? chalk.red('ERR')
          : chalk.green('OK ');

        console.log(`  ${chalk.gray(ts)}  ${badge}  ${chalk.gray(dur)}`);
        console.log(`  ${chalk.cyan(truncate(r.query, 100))}`);

        if (r.error) {
          console.log(`  ${chalk.red(r.error)}`);
        } else if (r.row_count != null) {
          console.log(chalk.gray(`  ${r.row_count} row(s)`));
        }
        console.log();
      });

      console.log(chalk.gray(`  Showing ${rows.length} entries`));
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err: any) {
    spinner.fail('Could not fetch logs');
    console.log(chalk.gray(`  ${err.message}`));
    console.log(chalk.gray('  Make sure the platform database is accessible.'));
  }
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}
