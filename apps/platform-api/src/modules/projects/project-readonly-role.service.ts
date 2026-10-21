import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { AdminTarget } from './project-provisioning.service';

/**
 * A project's read-only companion role: `<dbUser>_readonly`.
 *
 * It is the owner credential minus every write — meant for BI tools, reporting
 * and support access that should never be able to change data. It can SELECT
 * from every table and sequence the owner has or will create, and nothing
 * else: no DDL, no DML, no role or database privileges. `BYPASSRLS` keeps its
 * view identical to the owner's (table owners are not subject to row policies
 * either); without it every policy-protected table would look empty from a
 * reporting tool, because policies read a request identity that only exists
 * inside the API. `default_transaction_read_only = on` additionally refuses
 * writes attempted through owner-defined SECURITY DEFINER functions unless a
 * client turns the setting off on purpose.
 *
 * Only SQL lives here, so the behaviour is testable with a mocked driver; the
 * permission checks, Prisma writes and pooler reload belong to ProjectsService.
 */

export const READONLY_ROLE_SUFFIX = '_readonly';
const IDENT_RE = /^[a-z0-9_]{1,63}$/;
const SCHEMA_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS';

/** `<owner>_readonly`, sanitised and kept within Postgres' 63-character limit. */
export function readonlyRoleNameFor(ownerUser: string): string {
  const base = ownerUser.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!base) throw new BadRequestException('Invalid project owner identifier');
  return base.slice(0, 63 - READONLY_ROLE_SUFFIX.length) + READONLY_ROLE_SUFFIX;
}

function assertIdent(value: string, what: string): void {
  if (!IDENT_RE.test(value)) {
    throw new BadRequestException(`Invalid ${what} identifier`);
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

@Injectable()
export class ProjectReadonlyRoleService {
  private readonly logger = new Logger(ProjectReadonlyRoleService.name);

  private pool(target: AdminTarget, database: string): Pool {
    return new Pool({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database,
      max: 1,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  private async withClient<T>(
    target: AdminTarget,
    database: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = this.pool(target, database);
    try {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  /**
   * Create the role, or reset it if a previous attempt left one behind, then
   * grant it SELECT across the database. Idempotent: calling it again rotates
   * the password and repairs the grants.
   */
  async provision(p: AdminTarget & {
    dbName: string;
    ownerUser: string;
    readonlyRole: string;
    password: string;
  }): Promise<{ warnings: string[] }> {
    assertIdent(p.dbName, 'database');
    assertIdent(p.ownerUser, 'project owner');
    assertIdent(p.readonlyRole, 'read-only role');
    if (!p.password) throw new BadRequestException('A password is required');

    await this.withClient(p, 'postgres', async (c) => {
      const existing = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [p.readonlyRole]);
      if (existing.rowCount) {
        await c.query(
          `ALTER ROLE "${p.readonlyRole}" WITH ${ROLE_ATTRIBUTES} PASSWORD ${sqlLiteral(p.password)}`,
        );
      } else {
        await c.query(
          `CREATE ROLE "${p.readonlyRole}" ${ROLE_ATTRIBUTES} PASSWORD ${sqlLiteral(p.password)}`,
        );
      }
      await c.query(`ALTER ROLE "${p.readonlyRole}" SET default_transaction_read_only = on`);
      // createDatabase revokes CONNECT from PUBLIC, so the companion needs its own.
      await c.query(`GRANT CONNECT ON DATABASE "${p.dbName}" TO "${p.readonlyRole}"`);
    });

    const warnings = await this.withClient(p, p.dbName, (c) =>
      this.refreshGrants(c, p.ownerUser, p.readonlyRole),
    );
    this.logger.log(
      `Read-only role "${p.readonlyRole}" ready on "${p.dbName}"` +
        (warnings.length ? ` with ${warnings.length} warning(s)` : ''),
    );
    return { warnings };
  }

  /**
   * SELECT on everything that exists now, in every non-system schema, plus
   * default privileges so what the owner creates later is covered without a
   * re-run. Each statement is tolerated on its own; problems come back as
   * warnings instead of aborting the rest.
   */
  async refreshGrants(
    client: PoolClient,
    ownerUser: string,
    readonlyRole: string,
  ): Promise<string[]> {
    assertIdent(ownerUser, 'project owner');
    assertIdent(readonlyRole, 'read-only role');

    const { rows } = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
        WHERE nspname NOT IN ('pg_catalog', 'information_schema')
          AND nspname NOT LIKE 'pg\\_%'
        ORDER BY nspname`,
    );

    const warnings: string[] = [];
    for (const { nspname } of rows) {
      if (!SCHEMA_IDENT_RE.test(nspname)) {
        warnings.push(`schema "${nspname}" skipped: unsupported identifier`);
        continue;
      }
      const schema = `"${nspname}"`;
      const statements = [
        `GRANT USAGE ON SCHEMA ${schema} TO "${readonlyRole}"`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO "${readonlyRole}"`,
        `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO "${readonlyRole}"`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${ownerUser}" IN SCHEMA ${schema} GRANT SELECT ON TABLES TO "${readonlyRole}"`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${ownerUser}" IN SCHEMA ${schema} GRANT SELECT ON SEQUENCES TO "${readonlyRole}"`,
      ];
      for (const sql of statements) {
        try {
          await client.query(sql);
        } catch (err: any) {
          warnings.push(`${nspname}: ${err?.message || err}`);
        }
      }
    }
    return warnings;
  }

  async setPassword(p: AdminTarget & { readonlyRole: string; password: string }): Promise<void> {
    assertIdent(p.readonlyRole, 'read-only role');
    if (!p.password) throw new BadRequestException('A password is required');
    await this.withClient(p, 'postgres', (c) =>
      c.query(`ALTER ROLE "${p.readonlyRole}" WITH PASSWORD ${sqlLiteral(p.password)}`),
    );
  }

  /**
   * Remove the role. While its database still exists the grants and
   * default-privilege entries inside it have to go first (`DROP OWNED BY`),
   * otherwise `DROP ROLE` refuses; once the database is gone only the role
   * itself is left. Every step is tolerated so a teardown is never blocked.
   */
  async drop(p: AdminTarget & { readonlyRole: string; dbName?: string }): Promise<{ warnings: string[] }> {
    assertIdent(p.readonlyRole, 'read-only role');
    const warnings: string[] = [];

    if (p.dbName) {
      assertIdent(p.dbName, 'database');
      try {
        const exists = await this.withClient(p, 'postgres', async (c) => {
          const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [p.dbName]);
          return Boolean(r.rowCount);
        });
        if (exists) {
          await this.withClient(p, p.dbName, (c) => c.query(`DROP OWNED BY "${p.readonlyRole}"`));
        }
      } catch (err: any) {
        warnings.push(`revoking grants in "${p.dbName}": ${err?.message || err}`);
      }
    }

    try {
      await this.withClient(p, 'postgres', (c) =>
        c.query(`DROP ROLE IF EXISTS "${p.readonlyRole}"`),
      );
    } catch (err: any) {
      warnings.push(`dropping role: ${err?.message || err}`);
    }

    if (warnings.length) {
      this.logger.warn(`Read-only role "${p.readonlyRole}" removal: ${warnings.join('; ')}`);
    }
    return { warnings };
  }
}
