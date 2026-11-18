#!/usr/bin/env node
// Applies the platform schema at container start with versioned migrations.
//
//   node scripts/migrate.mjs           baseline if needed, then `prisma migrate deploy`
//   node scripts/migrate.mjs --check   report what would happen, change nothing
//
// Replaces the old `prisma db push --accept-data-loss` start command, which
// silently dropped any column, table or data that schema.prisma no longer
// described. `migrate deploy` only runs the SQL committed under
// prisma/migrations/, never drops anything on its own, and stops on error.
//
// Three database states are handled:
//   1. Empty database (fresh install): `migrate deploy` creates everything,
//      starting from prisma/migrations/0_baseline.
//   2. Database built by the old `db push` start command (platform tables
//      exist, `0_baseline` not recorded): the database is compared with
//      schema.prisma; if it has everything the schema needs, any older
//      `_prisma_migrations` table is renamed to `_prisma_migrations_pre_baseline`
//      (kept, not dropped), `0_baseline` is recorded as applied without running,
//      and `migrate deploy` then applies only migrations newer than the baseline.
//      If the database is missing something the schema needs, start-up stops so
//      the baseline never hides a missing column. Objects that exist only in the
//      database (raw-SQL tables such as `embeddings_store`) are reported and left
//      alone. MIGRATE_BASELINE_ACCEPT_DRIFT=1 overrides the stop (owner decision).
//   3. Database already on versioned migrations: `migrate deploy` applies new
//      migrations, or does nothing.
//
// Any failure exits non-zero so the container does not start on a schema it
// could not apply. Concurrent replicas serialise on a Postgres advisory lock.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const BASELINE = '0_baseline';
const LEGACY_TABLE = '_prisma_migrations_pre_baseline';
// Distinct from Prisma's own migrate lock (72707369) so `migrate deploy` can
// still take its lock while this script holds ours.
const LOCK_KEY = 0x62_66_79_6d; // "bfym"

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = join(appDir, 'prisma', 'schema.prisma');
const prismaBin = join(appDir, 'node_modules', '.bin', 'prisma');
const checkOnly = process.argv.includes('--check');

function log(msg) {
  console.log(`[migrate] ${msg}`);
}

function fail(msg) {
  console.error(`[migrate] FATAL: ${msg}`);
  process.exit(1);
}

function prisma(args, { capture = false } = {}) {
  const res = spawnSync(prismaBin, args, {
    cwd: appDir,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (res.error) fail(`could not run prisma ${args[0]}: ${res.error.message}`);
  return res;
}

/** pg does not understand Prisma's URL options; keep `schema` for search_path. */
function pgConfig(databaseUrl) {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') || 'public';
  for (const key of [...url.searchParams.keys()]) {
    if (!['sslmode', 'application_name'].includes(key)) url.searchParams.delete(key);
  }
  return { connectionString: url.toString(), schema };
}

/**
 * Statements that only remove objects which exist in the database but not in
 * schema.prisma. Those are left alone (migrate deploy never drops them), so
 * they do not block a baseline. Everything else means the database lacks or
 * differs from something the schema expects.
 */
function isExtraObjectOnly(stmt) {
  if (/^DROP\s+(TABLE|INDEX|TYPE|SEQUENCE|VIEW)\b/i.test(stmt)) return true;
  const alter = stmt.match(/^ALTER\s+TABLE\s+("[^"]+"(?:\."[^"]+")?|\S+)\s+([\s\S]*)$/i);
  if (!alter) return false;
  return alter[2]
    .split(/,\s*\n/)
    .every((clause) => /^\s*DROP\s+(COLUMN|CONSTRAINT)\b/i.test(clause));
}

function splitStatements(script) {
  return script
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('DATABASE_URL is not set');

  const { connectionString, schema } = pgConfig(databaseUrl);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['search_path', `"${schema}"`]);
    log(`waiting for migration lock (schema "${schema}")`);
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const regclass = async (name) =>
      (await client.query('SELECT to_regclass($1) AS r', [`"${schema}"."${name}"`])).rows[0].r;

    const hasPlatformTables = Boolean((await regclass('users')) || (await regclass('projects')));
    const hasMigrationsTable = Boolean(await regclass('_prisma_migrations'));
    let baselineRecorded = false;
    if (hasMigrationsTable) {
      const { rows } = await client.query(
        'SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1 AND rolled_back_at IS NULL LIMIT 1',
        [BASELINE],
      );
      baselineRecorded = rows.length > 0;
    }

    if (!hasPlatformTables) {
      log('no platform tables found: fresh database, migrate deploy will create the schema');
    } else if (baselineRecorded) {
      log(`${BASELINE} is recorded: database is on versioned migrations`);
    } else {
      log(`platform tables exist but ${BASELINE} is not recorded: database was built by db push, baselining`);

      const diff = prisma(
        ['migrate', 'diff', '--from-url', databaseUrl, '--to-schema-datamodel', schemaPath, '--script'],
        { capture: true },
      );
      if (diff.status !== 0) fail('prisma migrate diff failed; cannot verify the database before baselining');

      const statements = splitStatements(diff.stdout);
      const extra = statements.filter(isExtraObjectOnly);
      const missing = statements.filter((s) => !isExtraObjectOnly(s));

      if (extra.length) {
        log(`${extra.length} object(s) exist in the database but not in schema.prisma; they are kept untouched:`);
        for (const s of extra) log(`  kept as is: ${s.split('\n')[0].replace(/^DROP\s+/i, '')}`);
      }
      if (missing.length) {
        console.error('[migrate] the database differs from schema.prisma in ways the baseline would hide:');
        for (const s of missing) console.error(`  ${s.replace(/\n/g, '\n  ')};`);
        if (process.env.MIGRATE_BASELINE_ACCEPT_DRIFT === '1') {
          log('MIGRATE_BASELINE_ACCEPT_DRIFT=1: recording the baseline anyway');
        } else {
          fail(
            'refusing to baseline a database that does not match schema.prisma. Bring it in line ' +
              '(e.g. start the previous release once) or, as an owner decision, set MIGRATE_BASELINE_ACCEPT_DRIFT=1.',
          );
        }
      } else {
        log('database matches schema.prisma');
      }

      if (checkOnly) {
        log(`--check: would ${hasMigrationsTable ? `rename _prisma_migrations to ${LEGACY_TABLE}, ` : ''}record ${BASELINE} as applied, then migrate deploy`);
        return;
      }

      if (hasMigrationsTable) {
        // The pre-baseline history (partial, one row unfinished) cannot coexist
        // with the new one; keep it under another name instead of dropping it.
        let target = LEGACY_TABLE;
        if (await regclass(target)) target = `${LEGACY_TABLE}_${Date.now()}`;
        log(`renaming old _prisma_migrations to ${target}`);
        await client.query('BEGIN');
        await client.query(`ALTER TABLE "_prisma_migrations" RENAME TO "${target}"`);
        await client.query(
          `DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '_prisma_migrations_pkey'
                        AND conrelid = '"${schema}"."${target}"'::regclass) THEN
               ALTER TABLE "${target}" RENAME CONSTRAINT "_prisma_migrations_pkey" TO "${target}_pkey";
             END IF;
           END $$`,
        );
        await client.query('COMMIT');
      }

      const resolve = prisma(['migrate', 'resolve', '--applied', BASELINE]);
      if (resolve.status !== 0) fail(`prisma migrate resolve --applied ${BASELINE} failed`);
      log(`${BASELINE} recorded as applied`);
    }

    if (checkOnly) {
      const status = prisma(['migrate', 'status']);
      process.exitCode = status.status === 0 ? 0 : 1;
      return;
    }

    const deploy = prisma(['migrate', 'deploy']);
    if (deploy.status !== 0) fail('prisma migrate deploy failed; not starting');
    log('schema is up to date');
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => fail(err?.stack || String(err)));
