import chalk from 'chalk';
import { Pool } from 'pg';
import { getProjectConfig, getLocalEnv } from '../lib/config.js';
import { error, printHeader, createSpinner } from '../lib/ui.js';

interface InspectOptions {
  table?: string;
}

export async function inspectCommand(options: InspectOptions) {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('Not linked to a project. Run:  kb link  or  kb init');
    process.exit(1);
  }

  const env = await getLocalEnv();
  if (!env.DATABASE_URL) {
    error('DATABASE_URL not found in .env — run  kb link  to refresh credentials');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL });

  try {
    if (options.table) {
      await inspectTable(pool, options.table);
    } else {
      await inspectAll(pool);
    }
  } catch (err: any) {
    error(`Database error: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function inspectAll(pool: Pool) {
  const spinner = createSpinner('Querying database…');

  const { rows } = await pool.query(`
    SELECT
      t.table_name,
      pg_total_relation_size(quote_ident(t.table_name))  AS total_bytes,
      pg_size_pretty(pg_total_relation_size(quote_ident(t.table_name))) AS size,
      (SELECT reltuples::bigint FROM pg_class WHERE relname = t.table_name) AS est_rows
    FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY total_bytes DESC
  `);

  spinner.stop();

  if (!rows.length) {
    console.log(chalk.gray('  No tables found. Push a schema first:  kb db push'));
    return;
  }

  printHeader('Tables');
  console.log();

  const nameW = Math.max(10, ...rows.map((r: any) => r.table_name.length));

  console.log(
    `  ${chalk.bold('Table'.padEnd(nameW))}  ${chalk.bold('Rows'.padStart(10))}  ${chalk.bold('Size'.padStart(10))}`,
  );
  console.log(chalk.gray('  ' + '─'.repeat(nameW + 24)));

  for (const r of rows) {
    const rowCount = Number(r.est_rows) >= 0 ? Number(r.est_rows).toLocaleString() : '—';
    console.log(
      `  ${chalk.cyan(r.table_name.padEnd(nameW))}  ${rowCount.padStart(10)}  ${String(r.size).padStart(10)}`,
    );
  }

  console.log();
  console.log(chalk.gray(`  ${rows.length} table(s)`));
  console.log(chalk.gray('  Inspect a table:  kb inspect --table <name>'));
}

async function inspectTable(pool: Pool, tableName: string) {
  const spinner = createSpinner(`Inspecting ${tableName}…`);

  // Columns
  const { rows: columns } = await pool.query(`
    SELECT
      c.column_name,
      c.data_type,
      c.udt_name,
      c.is_nullable,
      c.column_default,
      c.character_maximum_length
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = $1
    ORDER BY c.ordinal_position
  `, [tableName]);

  if (!columns.length) {
    spinner.fail(`Table "${tableName}" not found`);
    process.exit(1);
  }

  // Indexes
  const { rows: indexes } = await pool.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = $1
  `, [tableName]);

  // Foreign keys
  const { rows: fkeys } = await pool.query(`
    SELECT
      kcu.column_name,
      ccu.table_name  AS foreign_table,
      ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
    WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'
  `, [tableName]);

  // Row count + size
  const { rows: meta } = await pool.query(`
    SELECT
      pg_size_pretty(pg_total_relation_size(quote_ident($1))) AS size,
      (SELECT reltuples::bigint FROM pg_class WHERE relname = $1)  AS est_rows
  `, [tableName]);

  spinner.stop();

  printHeader(`Table: ${tableName}`);
  console.log();

  if (meta[0]) {
    console.log(`  ${chalk.gray('Rows')}   ${Number(meta[0].est_rows).toLocaleString()}`);
    console.log(`  ${chalk.gray('Size')}   ${meta[0].size}`);
    console.log();
  }

  // Columns table
  console.log(chalk.bold('  Columns'));

  const nameW = Math.max(6, ...columns.map((c: any) => c.column_name.length));
  const typeW = Math.max(4, ...columns.map((c: any) => formatType(c).length));

  console.log(
    `  ${chalk.gray('Name'.padEnd(nameW))}  ${chalk.gray('Type'.padEnd(typeW))}  ${chalk.gray('Nullable')}  ${chalk.gray('Default')}`,
  );
  console.log(chalk.gray('  ' + '─'.repeat(nameW + typeW + 24)));

  for (const col of columns) {
    const nullable = col.is_nullable === 'YES' ? chalk.yellow('YES') : chalk.gray('NO ');
    const def = col.column_default ? chalk.gray(truncate(col.column_default, 30)) : '';
    const fk = fkeys.find((f: any) => f.column_name === col.column_name);
    const fkLabel = fk ? chalk.blue(` → ${fk.foreign_table}.${fk.foreign_column}`) : '';

    console.log(
      `  ${chalk.cyan(col.column_name.padEnd(nameW))}  ${formatType(col).padEnd(typeW)}  ${nullable}       ${def}${fkLabel}`,
    );
  }

  // Indexes
  if (indexes.length) {
    console.log();
    console.log(chalk.bold('  Indexes'));
    for (const idx of indexes) {
      console.log(`  ${chalk.gray('•')} ${idx.indexname}`);
    }
  }

  console.log();
}

function formatType(col: any): string {
  let t = col.udt_name || col.data_type;
  if (col.character_maximum_length) t += `(${col.character_maximum_length})`;
  return t;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
