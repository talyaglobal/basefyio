import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { AdminTarget } from './project-provisioning.service';

export type ExtraRoleMember = 'anon' | 'authenticated' | 'service_role';
/** Kept for callers that name one role; `none` means no membership. */
export type ExtraRoleMemberOf = ExtraRoleMember | 'none';

const MEMBERS: readonly ExtraRoleMember[] = ['anon', 'authenticated', 'service_role'];

/** Run-time limits applied to the role with ALTER ROLE … SET, in milliseconds (0 = no limit). */
export interface ExtraRoleSettings {
  statementTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
  lockTimeoutMs?: number;
}

const SETTING_GUC: Record<keyof ExtraRoleSettings, string> = {
  statementTimeoutMs: 'statement_timeout',
  idleInTransactionSessionTimeoutMs: 'idle_in_transaction_session_timeout',
  lockTimeoutMs: 'lock_timeout',
};
/** Input names: the API's camelCase, or the Postgres setting name. */
const SETTING_ALIASES: Record<string, keyof ExtraRoleSettings> = {
  statementTimeout: 'statementTimeoutMs',
  statementTimeoutMs: 'statementTimeoutMs',
  statement_timeout: 'statementTimeoutMs',
  idleInTransactionSessionTimeout: 'idleInTransactionSessionTimeoutMs',
  idleInTransactionSessionTimeoutMs: 'idleInTransactionSessionTimeoutMs',
  idle_in_transaction_session_timeout: 'idleInTransactionSessionTimeoutMs',
  lockTimeout: 'lockTimeoutMs',
  lockTimeoutMs: 'lockTimeoutMs',
  lock_timeout: 'lockTimeoutMs',
};
const MAX_SETTING_MS = 24 * 60 * 60 * 1000;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000 };

/**
 * The memberships asked for: a role name, a comma list, an array, or "none".
 * Returned de-duplicated in a fixed order, so the stored value is stable.
 */
export function parseMemberOf(input: unknown): ExtraRoleMember[] {
  if (input === undefined || input === null || input === '' || input === 'none') return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const wanted = new Set<string>();
  for (const v of raw) {
    const name = String(v).trim().toLowerCase();
    if (!name || name === 'none') continue;
    if (!(MEMBERS as readonly string[]).includes(name)) {
      throw new BadRequestException(`Invalid memberOf value: ${name} (use anon, authenticated, service_role or none)`);
    }
    wanted.add(name);
  }
  return MEMBERS.filter((m) => wanted.has(m));
}

export function memberOfColumn(members: ExtraRoleMember[]): string {
  return members.length ? members.join(',') : 'none';
}

export function memberOfFromColumn(value: string | null | undefined): ExtraRoleMember[] {
  return parseMemberOf(value ?? 'none');
}

function toMs(value: unknown, key: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < 0 || value > MAX_SETTING_MS) throw new BadRequestException(`${key} must be between 0 and 24 h`);
    return value;
  }
  const m = typeof value === 'string' ? /^\s*(\d{1,8})\s*(ms|s|min|h)?\s*$/i.exec(value) : null;
  if (!m) throw new BadRequestException(`${key} must be milliseconds or a value like "30s", "5min"`);
  const ms = Number(m[1]) * UNIT_MS[(m[2] ?? 'ms').toLowerCase()];
  if (ms > MAX_SETTING_MS) throw new BadRequestException(`${key} must be between 0 and 24 h`);
  return ms;
}

/** Validated limits; unknown keys are refused so a typo is not silently ignored. */
export function parseRoleSettings(input: unknown): ExtraRoleSettings {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('settings must be an object');
  }
  const out: ExtraRoleSettings = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const target = SETTING_ALIASES[key];
    if (!target) {
      throw new BadRequestException(
        `Unknown setting "${key}" (use statementTimeout, idleInTransactionSessionTimeout or lockTimeout)`,
      );
    }
    if (value === null) continue;
    out[target] = toMs(value, key);
  }
  return out;
}
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
    /** One role or several; [] / 'none' = no membership. */
    memberOf: ExtraRoleMemberOf | ExtraRoleMember[];
    settings?: ExtraRoleSettings;
  }): Promise<void> {
    assertIdent(p.dbName, 'database');
    assertIdent(p.roleName, 'extra role');
    const members = parseMemberOf(p.memberOf);
    const settings = parseRoleSettings(p.settings ?? {});
    if (!p.rolePassword) throw new BadRequestException('A password is required');

    await this.withClient(p, async (c) => {
      const { rows } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [p.roleName]);
      if (rows.length) {
        await c.query(`ALTER ROLE "${p.roleName}" WITH ${ROLE_ATTRIBUTES} PASSWORD ${sqlLiteral(p.rolePassword)}`);
      } else {
        await c.query(`CREATE ROLE "${p.roleName}" WITH ${ROLE_ATTRIBUTES} PASSWORD ${sqlLiteral(p.rolePassword)}`);
      }
      await c.query(`ALTER ROLE "${p.roleName}" RESET ALL`);
      // The limits the project asked for survive every re-provision: they are part of the role's definition.
      for (const [key, guc] of Object.entries(SETTING_GUC) as Array<[keyof ExtraRoleSettings, string]>) {
        const ms = settings[key];
        if (ms !== undefined) await c.query(`ALTER ROLE "${p.roleName}" SET ${guc} = ${Math.trunc(ms)}`);
      }
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

      // Grant each target membership with INHERIT FALSE, SET TRUE.
      for (const member of members) {
        await c.query(`GRANT "${member}" TO "${p.roleName}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
      }
    });

    this.logger.log(`Extra role "${p.roleName}" (memberOf=${memberOfColumn(members)}) ready on "${p.dbName}"`);
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
