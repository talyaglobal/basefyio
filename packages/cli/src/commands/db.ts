import inquirer from 'inquirer';
import chalk from 'chalk';
import { Pool } from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig, getLocalEnv } from '../lib/config.js';
import { success, error, warning, info, createSpinner } from '../lib/ui.js';

export async function dbCommand() {
  console.log(chalk.bold.cyan('Database Management\n'));
  info('Use db subcommands: push, pull, reset, seed, diff');
}

export async function dbPush() {
  console.log(chalk.bold.cyan('Push Database Schema\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a Kolaybase project. Run: kb init');
    process.exit(1);
  }

  const spinner = createSpinner('Analyzing schema changes...');

  try {
    const env = await getLocalEnv();
    const schemaPath = await findSchemaFile();

    if (!schemaPath) {
      spinner.fail('No schema file found');
      error('Could not find schema.prisma, schema.sql, or migrations directory');
      process.exit(1);
    }

    spinner.text = 'Pushing schema to database...';

    // If Prisma schema exists, use Prisma
    if (schemaPath.endsWith('.prisma')) {
      const { execa } = await import('execa');
      await execa('npx', ['prisma', 'db', 'push'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: env.DATABASE_URL,
        },
      });
    } else {
      // Execute SQL file
      const sql = await fs.readFile(schemaPath, 'utf-8');
      await apiClient.executeSQL(config.projectId!, sql);
    }

    spinner.succeed('Schema pushed successfully');
    success('Database is up to date');
  } catch (err) {
    spinner.fail('Failed to push schema');
    handleApiError(err);
  }
}

export async function dbPull() {
  console.log(chalk.bold.cyan('Pull Database Schema\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a Kolaybase project. Run: kb init');
    process.exit(1);
  }

  const spinner = createSpinner('Pulling schema from database...');

  try {
    const env = await getLocalEnv();

    // Check if Prisma is being used
    const prismaPath = path.join(process.cwd(), 'prisma', 'schema.prisma');
    
    try {
      await fs.access(prismaPath);
      
      // Use Prisma introspection
      const { execa } = await import('execa');
      await execa('npx', ['prisma', 'db', 'pull'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: env.DATABASE_URL,
        },
      });

      spinner.succeed('Schema pulled successfully');
    } catch {
      // No Prisma, generate SQL dump
      spinner.text = 'Generating SQL dump...';
      
      const pool = new Pool({
        connectionString: env.DATABASE_URL,
      });

      const client = await pool.connect();
      
      try {
        const { rows } = await client.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public'
          ORDER BY table_name
        `);

        const tables = rows.map(r => r.table_name);
        
        let schemaDump = '-- Database schema dump\n\n';
        
        for (const table of tables) {
          const { rows: columns } = await client.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = $1
            ORDER BY ordinal_position
          `, [table]);

          schemaDump += `CREATE TABLE IF NOT EXISTS ${table} (\n`;
          schemaDump += columns.map(col => {
            let def = `  ${col.column_name} ${col.data_type}`;
            if (col.is_nullable === 'NO') def += ' NOT NULL';
            if (col.column_default) def += ` DEFAULT ${col.column_default}`;
            return def;
          }).join(',\n');
          schemaDump += '\n);\n\n';
        }

        await fs.mkdir('db', { recursive: true });
        await fs.writeFile('db/schema.sql', schemaDump);

        spinner.succeed('Schema pulled successfully');
        info('Schema saved to db/schema.sql');
      } finally {
        client.release();
        await pool.end();
      }
    }
  } catch (err) {
    spinner.fail('Failed to pull schema');
    handleApiError(err);
  }
}

interface ResetOptions {
  force?: boolean;
}

export async function dbReset(options: ResetOptions) {
  console.log(chalk.bold.cyan('Reset Database\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a Kolaybase project. Run: kb init');
    process.exit(1);
  }

  console.log(chalk.yellow('⚠ WARNING: This will delete all data in the database!'));
  console.log();

  if (!options.force) {
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to reset the database?',
        default: false,
      },
    ]);

    if (!answers.confirm) {
      info('Reset cancelled');
      return;
    }
  }

  const spinner = createSpinner('Resetting database...');

  try {
    const env = await getLocalEnv();
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
    });

    const client = await pool.connect();

    try {
      // Get all tables
      const { rows } = await client.query(`
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
      `);

      // Drop all tables
      for (const row of rows) {
        await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }

      spinner.succeed('Database reset successfully');
      success('All tables dropped');
      
      console.log();
      info('To recreate schema, run: kb db push');
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    spinner.fail('Failed to reset database');
    handleApiError(err);
  }
}

export async function dbSeed() {
  console.log(chalk.bold.cyan('Seed Database\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a Kolaybase project. Run: kb init');
    process.exit(1);
  }

  const spinner = createSpinner('Looking for seed file...');

  try {
    const seedPaths = [
      'prisma/seed.ts',
      'prisma/seed.js',
      'db/seed.sql',
      'seeds/seed.sql',
    ];

    let seedPath: string | null = null;

    for (const p of seedPaths) {
      try {
        await fs.access(p);
        seedPath = p;
        break;
      } catch {
        // Continue searching
      }
    }

    if (!seedPath) {
      spinner.fail('No seed file found');
      warning('Create a seed file at prisma/seed.ts or db/seed.sql');
      return;
    }

    spinner.text = 'Running seed...';

    if (seedPath.endsWith('.sql')) {
      const sql = await fs.readFile(seedPath, 'utf-8');
      await apiClient.executeSQL(config.projectId!, sql);
    } else {
      const { execa } = await import('execa');
      await execa('npx', ['prisma', 'db', 'seed'], {
        stdio: 'inherit',
      });
    }

    spinner.succeed('Database seeded successfully');
  } catch (err) {
    spinner.fail('Failed to seed database');
    handleApiError(err);
  }
}

export async function dbDiff() {
  console.log(chalk.bold.cyan('Database Schema Diff\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a Kolaybase project. Run: kb init');
    process.exit(1);
  }

  info('Checking for schema differences...');
  
  try {
    const { execa } = await import('execa');
    await execa('npx', ['prisma', 'migrate', 'diff'], {
      stdio: 'inherit',
    });
  } catch (err) {
    warning('Could not generate diff. Make sure Prisma is configured.');
  }
}

interface DumpOptions {
  output?: string;
}

export async function dbDump(options: DumpOptions) {
  console.log(chalk.bold.cyan('Dump Database Schema\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a Kolaybase project. Run: kb init');
    process.exit(1);
  }

  const spinner = createSpinner('Dumping schema…');

  try {
    const env = await getLocalEnv();
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    const client = await pool.connect();

    try {
      const { rows: tables } = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);

      let dump = '-- Kolaybase schema dump\n-- Generated: ' + new Date().toISOString() + '\n\n';

      for (const t of tables) {
        const { rows: cols } = await client.query(`
          SELECT column_name, udt_name, is_nullable, column_default, character_maximum_length
          FROM information_schema.columns
          WHERE table_name = $1
          ORDER BY ordinal_position
        `, [t.table_name]);

        dump += `CREATE TABLE IF NOT EXISTS "${t.table_name}" (\n`;
        dump += cols.map((c: any) => {
          let def = `  "${c.column_name}" ${c.udt_name}`;
          if (c.character_maximum_length) def += `(${c.character_maximum_length})`;
          if (c.is_nullable === 'NO') def += ' NOT NULL';
          if (c.column_default) def += ` DEFAULT ${c.column_default}`;
          return def;
        }).join(',\n');
        dump += '\n);\n\n';
      }

      const outFile = options.output || 'schema.sql';
      await fs.writeFile(outFile, dump);

      spinner.succeed(`Schema dumped to ${chalk.cyan(outFile)}`);
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    spinner.fail('Failed to dump schema');
    handleApiError(err);
  }
}

async function findSchemaFile(): Promise<string | null> {
  const paths = [
    'prisma/schema.prisma',
    'db/schema.sql',
    'schema.sql',
    'migrations',
  ];

  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // Continue searching
    }
  }

  return null;
}
