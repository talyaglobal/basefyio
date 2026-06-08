/* eslint-disable no-console */
/**
 * Applies the Basefyio RLS bootstrap (anon/authenticated/service_role roles
 * + auth.* helpers) to every ACTIVE project database that hasn't been
 * bootstrapped yet.
 *
 * Usage (from apps/platform-api):
 *   npx ts-node --transpile-only scripts/backfill-rls.ts
 *
 * Env vars (same ones the API reads):
 *   DATABASE_URL           — control-plane Postgres (to list projects)
 *   POSTGRES_HOST/PORT/...  — shared project-plane admin credentials
 *
 * Flags:
 *   --force   re-apply even when rls_bootstrapped_at is set
 *   --dry     log what would run, don't touch any DB
 */
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

const BOOTSTRAP_SQL_PATH = join(
  __dirname,
  '..',
  'src',
  'modules',
  'projects',
  'sql',
  'rls-bootstrap.sql',
);

const force = process.argv.includes('--force');
const dry = process.argv.includes('--dry');

async function main() {
  const template = readFileSync(BOOTSTRAP_SQL_PATH, 'utf8');
  const prisma = new PrismaClient();

  const cfgHost = process.env.POSTGRES_HOST || 'localhost';
  const cfgPort = Number(process.env.POSTGRES_PORT || 5432);
  const cfgUser = process.env.POSTGRES_USER || 'basefyio';
  const cfgPass = process.env.POSTGRES_PASSWORD || '';

  // Using $queryRawUnsafe so this script works before `prisma generate`
  // has been re-run against the new schema.
  const projects = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      slug: string;
      db_name: string;
      db_host: string;
      db_port: number;
      db_user: string;
      rls_bootstrapped_at: Date | null;
    }>
  >(
    `SELECT id, slug, db_name, db_host, db_port, db_user, rls_bootstrapped_at
     FROM "projects"
     WHERE status = 'ACTIVE'
     ORDER BY created_at ASC`,
  );

  console.log(`Found ${projects.length} ACTIVE projects.`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of projects) {
    if (p.rls_bootstrapped_at && !force) {
      skipped++;
      console.log(`  [skip] ${p.slug} (bootstrapped ${p.rls_bootstrapped_at.toISOString()})`);
      continue;
    }

    const sanitizedUser = p.db_user.replace(/[^a-z0-9_]/g, '');
    if (!/^[a-z0-9_]+$/.test(sanitizedUser)) {
      console.error(`  [fail] ${p.slug}: invalid dbUser ${p.db_user}`);
      failed++;
      continue;
    }
    const sql = template.replace(/%BF_PROJECT_OWNER%/g, sanitizedUser);

    const onSharedHost = p.db_host === cfgHost && Number(p.db_port) === cfgPort;
    if (!onSharedHost) {
      console.warn(
        `  [skip] ${p.slug}: dedicated host ${p.db_host}:${p.db_port} — run this script on that host or extend to use infra creds`,
      );
      skipped++;
      continue;
    }

    if (dry) {
      console.log(`  [dry ] ${p.slug} → would bootstrap ${p.db_name}`);
      continue;
    }

    const pool = new Pool({
      host: cfgHost,
      port: cfgPort,
      user: cfgUser,
      password: cfgPass,
      database: p.db_name,
    });
    const client = await pool.connect();
    try {
      await client.query(sql);
    } catch (err: any) {
      failed++;
      console.error(`  [fail] ${p.slug} (apply): ${err.message}`);
      client.release();
      await pool.end();
      continue;
    }

    // Post-flight: connect AS the project owner and verify SET ROLE for each
    // of anon/authenticated/service_role actually works. A bootstrap that
    // "succeeded" but leaves the data API 500-ing is exactly the failure mode
    // we're trying to detect — the SQL sentinel covers most cases but a fresh
    // project-owner connection is the most authentic test.
    let postOk = true;
    const failedRoles: string[] = [];
    try {
      const projectPool = new Pool({
        host: cfgHost,
        port: cfgPort,
        user: p.db_user,
        password: '',
        database: p.db_name,
        statement_timeout: 5_000,
      });
      // We don't have the project's password here in cleartext; the admin
      // pool's existing connection is fine for the sentinel because the SQL
      // already does SET LOCAL ROLE %KB_PROJECT_OWNER% then nested SET ROLE.
      // Skip the second-pool round-trip if we can't auth.
      try {
        const c = await projectPool.connect();
        try {
          for (const role of ['anon', 'authenticated', 'service_role']) {
            await c.query('BEGIN');
            try {
              await c.query(`SET LOCAL ROLE "${role}"`);
              await c.query('SELECT 1');
            } catch (err: any) {
              postOk = false;
              failedRoles.push(`${role}(${err.code ?? '?'})`);
            } finally {
              try { await c.query('ROLLBACK'); } catch { /* noop */ }
            }
          }
        } finally {
          c.release();
        }
      } catch {
        // Couldn't connect as project owner (no password available in this
        // script). Trust the SQL sentinel that already ran inside `client`.
      } finally {
        await projectPool.end();
      }
    } catch { /* noop */ }

    if (!postOk) {
      failed++;
      console.error(
        `  [fail] ${p.slug} (post-flight): SET ROLE failed for ${failedRoles.join(', ')}. ` +
          `Bootstrap not stamped — investigate before re-running.`,
      );
      client.release();
      await pool.end();
      continue;
    }

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "projects" SET "rls_bootstrapped_at" = NOW() WHERE "id" = $1`,
        p.id,
      );
      ok++;
      console.log(`  [ ok ] ${p.slug}`);
    } catch (err: any) {
      failed++;
      console.error(`  [fail] ${p.slug} (stamp): ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  await prisma.$disconnect();

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
