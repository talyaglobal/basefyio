import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { AdminTarget } from './project-provisioning.service';

export type ExtraRoleMemberOf = 'anon' | 'authenticated' | 'service_role' | 'none';

const VALID_MEMBER_OF: Set<string> = new Set(['anon', 'authenticated', 'service_role', 'none']);
const IDENT_RE = /^[a-z0-9_]{1,63}$/;
const ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';

function assertIdent(value: string, what: string): void {
  if (!IDENT_RE.test(value)) throw new BadRequestException(`Invalid ${what} identifier`);
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Manages extra named LOGIN roles for a project. Each role is scoped to one
 * project, optionally a member of one of the platform's built-in roles
 * (anon / authenticated / service_role) with INHERIT FALSE, SET TRUE so the
 * caller must issue SET LOCAL ROLE explicitly — no silent privilege inheritance.
 *
 * SQL only lives here; permission checks and Prisma writes belong to ProjectsService.
 */
@Injectable()
export class ProjectExtraRoleService {
  private readonly logger = new Logger(ProjectExtraRoleService.name);

  private pool(target: AdminTarget): Pool {
    return new Pool({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: 'postgres',
      max: 1,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  private async withClient<T>(target: AdminTarget, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.pool(target);
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
   * Create or repair the role. Idempotent: a re-run re-asserts attributes,
   * password and membership and strips any extra memberships.
   */
  async provision(p: AdminTarget & {
    dbName: string;
    roleName: string;
    rolePassword: string;
    memberOf: ExtraRoleMemberOf;
  }): Promise<void> {
    assertIdent(p.dbName, 'database');
    assertIdent(p.roleName, 'extra role');
    if (!VALID_MEMBER_OF.has(p.memberOf)) {
      throw new BadRequestException(`Invalid memberOf value: ${p.memberOf}`);
    }
    if (!p.rolePassword) throw new BadRequestException('A password is required');

    await this.withClient(p, async (c) => {
      const { rows } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [p.roleName]);
      if (rows.length) {
        await c.query(`ALTER ROLE "${p.roleName}" WITH ${ROLE_ATTRIBUTES} PASSWORD ${sqlLiteral(p.rolePassword)}`);
      } else {
        await c.query(`CREATE ROLE "${p.roleName}" WITH ${ROLE_ATTRIBUTES} PASSWORD ${sqlLiteral(p.rolePassword)}`);
      }
      await c.query(`ALTER ROLE "${p.roleName}" RESET ALL`);
      await c.query(`GRANT CONNECT ON DATABASE "${p.dbName}" TO "${p.roleName}"`);

      // Strip any existing memberships (idempotency / drift repair).
      const { rows: memberships } = await c.query<{ rolename: string }>(
        `SELECT r.rolname FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid
           JOIN pg_roles mr ON mr.oid = m.member
          WHERE mr.rolname = $1`,
        [p.roleName],
      );
      for (const { rolename } of memberships) {
        await c.query(`REVOKE "${rolename}" FROM "${p.roleName}" CASCADE`).catch((err) =>
          this.logger.warn(`REVOKE ${rolename} FROM ${p.roleName}: ${err?.message}`),
        );
      }

      // Grant the target membership with INHERIT FALSE, SET TRUE.
      if (p.memberOf !== 'none') {
        await c.query(
          `GRANT "${p.memberOf}" TO "${p.roleName}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`,
        );
      }
    });

    this.logger.log(`Extra role "${p.roleName}" (memberOf=${p.memberOf}) ready on "${p.dbName}"`);
  }

  async setPassword(p: AdminTarget & { roleName: string; rolePassword: string }): Promise<void> {
    assertIdent(p.roleName, 'extra role');
    if (!p.rolePassword) throw new BadRequestException('A password is required');
    await this.withClient(p, (c) =>
      c.query(`ALTER ROLE "${p.roleName}" WITH PASSWORD ${sqlLiteral(p.rolePassword)}`),
    );
  }

  async drop(p: AdminTarget & { roleName: string; dbName?: string }): Promise<{ warnings: string[] }> {
    assertIdent(p.roleName, 'extra role');
    const warnings: string[] = [];

    if (p.dbName) {
      assertIdent(p.dbName, 'database');
      try {
        const exists = await this.withClient(p, async (c) => {
          const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [p.dbName]);
          return Boolean(r.rowCount);
        });
        if (exists) {
          const dbPool = new Pool({
            host: p.host, port: p.port, user: p.user, password: p.password,
            database: p.dbName, max: 1, statement_timeout: 30_000, connectionTimeoutMillis: 5_000,
          });
          try {
            const client = await dbPool.connect();
            try {
              await client.query(`DROP OWNED BY "${p.roleName}"`);
            } finally {
              client.release();
            }
          } catch (err: any) {
            warnings.push(`revoking grants in "${p.dbName}": ${err?.message || err}`);
          } finally {
            await dbPool.end().catch(() => undefined);
          }
        }
      } catch (err: any) {
        warnings.push(`checking database "${p.dbName}": ${err?.message || err}`);
      }
    }

    try {
      await this.withClient(p, (c) => c.query(`DROP ROLE IF EXISTS "${p.roleName}"`));
    } catch (err: any) {
      warnings.push(`dropping role: ${err?.message || err}`);
    }

    return { warnings };
  }
}
