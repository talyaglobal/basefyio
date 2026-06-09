/**
 * Drizzle client for the new tables.
 *
 * Uses the SAME Postgres instance and DATABASE_URL as Prisma (one database, two
 * ORMs during the transition). A single shared `pg` Pool is created lazily so the
 * NestJS provider can inject one connection without competing with Prisma's pool
 * for the existing tables.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type DrizzleDb = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;

export function createDrizzle(databaseUrl: string): DrizzleDb {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }
  return drizzle(pool, { schema });
}

export { schema };
