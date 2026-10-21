/**
 * Row-level security policies for a project database — list, create, replace,
 * drop, and switch RLS on or off per table.
 *
 * Reads come from the catalog (pg_class, pg_policies, pg_proc). Writes are
 * DDL built by project-policies.sql.ts and run in one transaction as the
 * project's own database user, the way indexes and triggers are managed. A
 * dry run returns the SQL without opening a connection; a dry run with
 * `check` runs the statements and rolls them back, so Postgres validates the
 * expressions without changing anything.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ProjectDatabaseService } from './project-database.service';
import { mapPgError } from './pg-error.util';
import {
  assertIdentifier,
  buildCreatePolicySql,
  buildDropPolicySql,
  buildRlsSql,
  normalizePolicyDefinition,
  normalizeRlsToggle,
  POLICY_ROLES,
  POLICY_SCHEMA,
  PolicyCommand,
  PolicyRole,
  renderScript,
} from './project-policies.sql';

export interface PolicyRow {
  name: string;
  command: PolicyCommand;
  permissive: boolean;
  roles: string[];
  using: string | null;
  withCheck: string | null;
}

export interface PolicyTable {
  schema: string;
  name: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: PolicyRow[];
}

/** Which auth.* helpers the database carries, so templates can match them. */
export interface RlsHelpers {
  uid: 'text' | 'uuid' | null;
  jwt: boolean;
  role: boolean;
  email: boolean;
  /** auth.uid() reads request.jwt.claim.sub (an imported definition). */
  uidReadsLegacyClaimKey: boolean;
}

export interface PoliciesOverview {
  tables: PolicyTable[];
  helpers: RlsHelpers;
  roles: PolicyRole[];
}

export interface MutationOpts {
  dryRun?: boolean;
  check?: boolean;
}

export interface PolicyMutationResult {
  sql: string;
  applied: boolean;
  checked: boolean;
  message: string;
}

/** DDL takes an exclusive lock on the table; never queue behind a long transaction. */
const LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '5s'`;

const TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS name,
         c.relrowsecurity AS "rlsEnabled", c.relforcerowsecurity AS "rlsForced"
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
  ORDER BY c.relname`;

const POLICIES_SQL = `
  SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies WHERE schemaname = $1
  ORDER BY tablename, policyname`;

const HELPERS_SQL = `
  SELECT p.proname, pg_get_function_result(p.oid) AS returns, p.prosrc
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'auth' AND p.pronargs = 0
    AND p.proname IN ('uid', 'jwt', 'role', 'email')`;

const POLICY_EXISTS_SQL = `
  SELECT 1 FROM pg_policies
  WHERE schemaname = $1 AND tablename = $2 AND policyname = $3`;

/** pg_policies.roles is name[]; node-pg parses it, but a raw `{a,b}` is handled too. */
function parseRoles(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    return value
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return [];
}

@Injectable()
export class ProjectPoliciesService {
  constructor(private readonly db: ProjectDatabaseService) {}

  async listPolicies(projectId: string, userId: string): Promise<PoliciesOverview> {
    return this.db.withProjectDb(projectId, userId, async (client) => {
      const [tables, policies, helpers] = await Promise.all([
        client.query(TABLES_SQL, [POLICY_SCHEMA]),
        client.query(POLICIES_SQL, [POLICY_SCHEMA]),
        client.query(HELPERS_SQL),
      ]);

      const byTable = new Map<string, PolicyRow[]>();
      for (const row of policies.rows) {
        const list = byTable.get(row.tablename) ?? [];
        list.push({
          name: row.policyname,
          command: String(row.cmd).toUpperCase() as PolicyCommand,
          permissive: String(row.permissive).toUpperCase() === 'PERMISSIVE',
          roles: parseRoles(row.roles),
          using: row.qual ?? null,
          withCheck: row.with_check ?? null,
        });
        byTable.set(row.tablename, list);
      }

      const helperInfo: RlsHelpers = {
        uid: null,
        jwt: false,
        role: false,
        email: false,
        uidReadsLegacyClaimKey: false,
      };
      for (const row of helpers.rows) {
        switch (row.proname) {
          case 'uid':
            helperInfo.uid = /uuid/i.test(String(row.returns ?? '')) ? 'uuid' : 'text';
            helperInfo.uidReadsLegacyClaimKey = /request\.jwt\.claim\.sub/i.test(
              String(row.prosrc ?? ''),
            );
            break;
          case 'jwt':
            helperInfo.jwt = true;
            break;
          case 'role':
            helperInfo.role = true;
            break;
          case 'email':
            helperInfo.email = true;
            break;
        }
      }

      return {
        tables: tables.rows.map((t) => ({
          schema: t.schema,
          name: t.name,
          rlsEnabled: Boolean(t.rlsEnabled),
          rlsForced: Boolean(t.rlsForced),
          policies: byTable.get(t.name) ?? [],
        })),
        helpers: helperInfo,
        roles: [...POLICY_ROLES],
      };
    });
  }

  async createPolicy(
    projectId: string,
    userId: string,
    raw: unknown,
    opts: MutationOpts = {},
  ): Promise<PolicyMutationResult> {
    const def = normalizePolicyDefinition(raw);
    return this.mutate(
      projectId,
      userId,
      [buildCreatePolicySql(def)],
      opts,
      `Policy "${def.name}" created on "${def.table}"`,
    );
  }

  /**
   * Replace = DROP + CREATE in one transaction. Postgres's ALTER POLICY cannot
   * change the command or the permissive flag, and transactional DDL means a
   * rejected CREATE leaves the old policy exactly as it was.
   */
  async replacePolicy(
    projectId: string,
    userId: string,
    table: string,
    name: string,
    raw: unknown,
    opts: MutationOpts = {},
  ): Promise<PolicyMutationResult> {
    assertIdentifier(name, 'policy');
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const def = normalizePolicyDefinition({ ...body, table });
    return this.mutate(
      projectId,
      userId,
      [buildDropPolicySql(table, name), buildCreatePolicySql(def)],
      opts,
      `Policy "${name}" updated on "${table}"`,
      (client) => this.assertPolicyExists(client, table, name),
    );
  }

  async dropPolicy(
    projectId: string,
    userId: string,
    table: string,
    name: string,
    opts: MutationOpts = {},
  ): Promise<PolicyMutationResult> {
    return this.mutate(
      projectId,
      userId,
      [buildDropPolicySql(table, name)],
      opts,
      `Policy "${name}" dropped from "${table}"`,
    );
  }

  async setRowLevelSecurity(
    projectId: string,
    userId: string,
    raw: unknown,
    opts: MutationOpts = {},
  ): Promise<PolicyMutationResult> {
    const toggle = normalizeRlsToggle(raw);
    const what = toggle.enabled ? 'enabled' : 'disabled';
    const forced =
      toggle.force === true ? ' and forced' : toggle.force === false ? ' and no longer forced' : '';
    return this.mutate(
      projectId,
      userId,
      buildRlsSql(toggle.table, toggle.enabled, toggle.force),
      opts,
      `Row-level security ${what}${forced} on "${toggle.table}"`,
    );
  }

  private async assertPolicyExists(client: PoolClient, table: string, name: string) {
    const r = await client.query(POLICY_EXISTS_SQL, [POLICY_SCHEMA, table, name]);
    if (!r.rowCount) throw new NotFoundException('Policy not found');
  }

  private async mutate(
    projectId: string,
    userId: string,
    statements: string[],
    opts: MutationOpts,
    message: string,
    precheck?: (client: PoolClient) => Promise<void>,
  ): Promise<PolicyMutationResult> {
    const sql = renderScript(statements);

    if (opts.dryRun && !opts.check) {
      return { sql, applied: false, checked: false, message: 'Dry run — nothing was executed' };
    }

    const mode: 'apply' | 'check' = opts.dryRun ? 'check' : 'apply';
    await this.db.withProjectDb(projectId, userId, async (client) => {
      if (precheck) {
        try {
          await precheck(client);
        } catch (e) {
          throw this.mapPolicyPgError(e);
        }
      }
      await this.runDdl(client, statements, mode);
    });

    return mode === 'check'
      ? {
          sql,
          applied: false,
          checked: true,
          message: 'Postgres accepted the statement; nothing was changed',
        }
      : { sql, applied: true, checked: true, message };
  }

  private async runDdl(client: PoolClient, statements: string[], mode: 'apply' | 'check') {
    try {
      await client.query('BEGIN');
      await client.query(LOCK_TIMEOUT_SQL);
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* noop */
      }
      throw this.mapPolicyPgError(e);
    }
  }

  /** Postgres errors that mean something specific for policy DDL. */
  private mapPolicyPgError(e: any): unknown {
    if (e instanceof HttpException) return e;
    switch (e?.code) {
      case '42501': // insufficient_privilege — here: not the table owner
        return new ForbiddenException(
          'The project database user must own this table to change its policies',
        );
      case '42710': // duplicate_object
        return new ConflictException('A policy with this name already exists on this table');
      case '42704': // undefined_object
        return new NotFoundException('Policy not found');
      case '42P01': // undefined_table
        return new NotFoundException('Table not found');
      case '55P03': // lock_not_available
        return new ConflictException(
          'The table is busy (locked by another session). Try again in a moment.',
        );
      case '42601': // syntax_error
      case '42703': // undefined_column
      case '42883': // undefined_function
      case '42804': // datatype_mismatch
      case '42P17': // invalid_object_definition
      case '22P02': // invalid_text_representation
      case '0A000': // feature_not_supported (e.g. a policy on a view)
        return new BadRequestException(`Postgres rejected the statement: ${e.message}`);
      default:
        return mapPgError(e);
    }
  }
}
