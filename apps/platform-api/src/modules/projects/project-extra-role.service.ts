import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { AdminTarget } from './project-provisioning.service';
import { CLUSTER_PREFIX_ROLES_SQL, isValidPrefixedRoleName } from './project-role-prefix';

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

/** Names the platform generates for a project's NOLOGIN group roles. */
export const GROUP_ROLE_RE = /^kb_xg_[0-9a-f]{10}$/;

/** A group role name the platform could have made: generated (`kb_xg_…`) or `<prefix>_<name>`. */
export function isPlatformGroupName(name: string): boolean {
  return GROUP_ROLE_RE.test(name) || isValidPrefixedRoleName(name);
}

export function isBuiltInMember(name: string): name is ExtraRoleMember {
  return (MEMBERS as readonly string[]).includes(name);
}

/**
 * The memberships asked for: a role name, a comma list, an array, or "none".
 * A built-in role (anon, authenticated, service_role) or one of the project's own
 * group roles (`groups`; `'any'` accepts any generated group name, for stored values).
 * Returned de-duplicated, built-ins first in a fixed order, then groups sorted.
 */
export function parseMemberOf(input: unknown, groups: readonly string[] | 'any' = []): string[] {
  if (input === undefined || input === null || input === '' || input === 'none') return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const wanted = new Set<string>();
  for (const v of raw) {
    const name = String(v).trim().toLowerCase();
    if (!name || name === 'none') continue;
    const groupOk = isPlatformGroupName(name) && (groups === 'any' || groups.includes(name));
    if (!isBuiltInMember(name) && !groupOk) {
      throw new BadRequestException(
        `Invalid memberOf value: ${name} (use anon, authenticated, service_role, one of this project's group roles, or none)`,
      );
    }
    wanted.add(name);
  }
  const builtIns = MEMBERS.filter((m) => wanted.has(m));
  const own = [...wanted].filter((m) => !isBuiltInMember(m)).sort();
  return [...builtIns, ...own];
}

export function memberOfColumn(members: readonly string[]): string {
  return members.length ? members.join(',') : 'none';
}

export function memberOfFromColumn(value: string | null | undefined): string[] {
  return parseMemberOf(value ?? 'none', 'any');
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

function roleTaken(name: string): ConflictException {
  return new ConflictException(`A database role named "${name}" already exists; choose another name`);
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
    /** One role or several; [] / 'none' = no membership. Group names were checked by the caller. */
    memberOf: ExtraRoleMemberOf | string[];
    settings?: ExtraRoleSettings;
    /**
     * A new role with a chosen name: refuse (409) when any role of that name exists in the
     * cluster, and run everything in one transaction so a failure leaves nothing behind.
     */
    mustNotExist?: boolean;
  }): Promise<void> {
    assertIdent(p.dbName, 'database');
    assertIdent(p.roleName, 'extra role');
    const members = parseMemberOf(p.memberOf, 'any');
    const settings = parseRoleSettings(p.settings ?? {});
    if (!p.rolePassword) throw new BadRequestException('A password is required');

    await this.withClient(p, (c) => this.inTransaction(c, Boolean(p.mustNotExist), async () => {
      const { rows } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [p.roleName]);
      if (rows.length && p.mustNotExist) throw roleTaken(p.roleName);
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

      // A built-in role is entered on purpose (INHERIT FALSE, SET TRUE: SET ROLE first). The project's
      // own group roles work as ordinary Postgres groups: their grants apply without SET ROLE.
      for (const member of members) {
        const inherit = isBuiltInMember(member) ? 'FALSE' : 'TRUE';
        await c.query(`GRANT "${member}" TO "${p.roleName}" WITH INHERIT ${inherit}, SET TRUE, ADMIN FALSE`);
      }
    }));

    this.logger.log(`Extra role "${p.roleName}" (memberOf=${memberOfColumn(members)}) ready on "${p.dbName}"`);
  }

  /**
   * A NOLOGIN group role of the project: it owns SECURITY DEFINER functions and receives grants.
   * Never a superuser, never BYPASSRLS, member of nothing. The project owner becomes its member
   * WITH INHERIT FALSE, SET TRUE, ADMIN FALSE: enough for ALTER FUNCTION … OWNER TO and for
   * SET ROLE, never for using its rights by accident. Idempotent.
   */
  async provisionGroup(p: AdminTarget & { roleName: string; ownerRole: string; mustNotExist?: boolean }): Promise<void> {
    assertIdent(p.roleName, 'group role');
    assertIdent(p.ownerRole, 'owner role');
    if (!isPlatformGroupName(p.roleName)) throw new BadRequestException('Invalid group role name');
    await this.withClient(p, (c) => this.inTransaction(c, Boolean(p.mustNotExist), async () => {
      const attrs = 'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION';
      const { rows } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [p.roleName]);
      if (rows.length && p.mustNotExist) throw roleTaken(p.roleName);
      await c.query(`${rows.length ? 'ALTER' : 'CREATE'} ROLE "${p.roleName}" WITH ${attrs}`);
      await c.query(`ALTER ROLE "${p.roleName}" RESET ALL`);
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
      await c.query(`GRANT "${p.roleName}" TO "${p.ownerRole}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
    }));
    this.logger.log(`Group role "${p.roleName}" ready, owner "${p.ownerRole}" may SET ROLE to it`);
  }

  /** `BEGIN … COMMIT` around `fn` when `tx`; role DDL is transactional, so a failure undoes it all. */
  private async inTransaction<T>(c: PoolClient, tx: boolean, fn: () => Promise<T>): Promise<T> {
    if (!tx) return fn();
    await c.query('BEGIN');
    try {
      const out = await fn();
      await c.query('COMMIT');
      return out;
    } catch (err: any) {
      await c.query('ROLLBACK').catch(() => undefined);
      // Another session created the same name between our check and CREATE ROLE.
      if (err?.code === '42710') throw new ConflictException('A database role with that name already exists');
      throw err;
    }
  }

  /** Cluster roles named `prefix` or `prefix_…`. */
  async rolesMatchingPrefix(target: AdminTarget, prefix: string): Promise<string[]> {
    assertIdent(prefix, 'role prefix');
    return this.withClient(target, async (c) => {
      const { rows } = await c.query<{ rolname: string }>(CLUSTER_PREFIX_ROLES_SQL, [prefix]);
      return rows.map((r) => r.rolname);
    });
  }

  async roleExists(target: AdminTarget, roleName: string): Promise<boolean> {
    assertIdent(roleName, 'role');
    return this.withClient(target, async (c) => {
      const { rows } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
      return rows.length > 0;
    });
  }

  /**
   * Make sure PUBLIC cannot CONNECT to the database: only roles granted CONNECT (the owner, the
   * read-only role, the project's extra roles) can. Idempotent; new databases get it at creation.
   */
  async revokePublicConnect(target: AdminTarget, dbName: string): Promise<boolean> {
    assertIdent(dbName, 'database');
    return this.withClient(target, async (c) => {
      const { rows } = await c.query<{ open: boolean }>(
        `SELECT has_database_privilege('public', datname, 'CONNECT') AS open FROM pg_database WHERE datname = $1`,
        [dbName],
      );
      if (!rows.length) return false;
      await c.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
      return Boolean(rows[0].open);
    });
  }

  async setPassword(p: AdminTarget & { roleName: string; rolePassword: string }): Promise<void> {
    assertIdent(p.roleName, 'extra role');
    if (!p.rolePassword) throw new BadRequestException('A password is required');
    await this.withClient(p, (c) =>
      c.query(`ALTER ROLE "${p.roleName}" WITH PASSWORD ${sqlLiteral(p.rolePassword)}`),
    );
  }

  /**
   * Remove a role. `reassignTo` (group roles): what it owns — functions, tables — goes to that role
   * first, so removing a group never deletes the project's objects; only its grants are revoked.
   */
  async drop(p: AdminTarget & { roleName: string; dbName?: string; reassignTo?: string }): Promise<{ warnings: string[] }> {
    assertIdent(p.roleName, 'extra role');
    if (p.reassignTo) assertIdent(p.reassignTo, 'owner role');
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
              if (p.reassignTo) await client.query(`REASSIGN OWNED BY "${p.roleName}" TO "${p.reassignTo}"`);
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
