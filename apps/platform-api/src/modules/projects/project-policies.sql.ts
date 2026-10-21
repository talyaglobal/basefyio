/**
 * Row-level security policy DDL — validators and builders.
 *
 * The dashboard's policy editor sends structured parts (table, name, command,
 * roles, expressions) and this module turns them into exactly one
 * CREATE POLICY / DROP POLICY / ALTER TABLE statement each. The USING and
 * WITH CHECK expressions are the customer's own SQL and are passed through;
 * validation here keeps each one a single expression — no statement
 * terminator, no comments, nothing from the SQL console's denylist — and
 * Postgres parses and type-checks the expression itself when the statement
 * runs. Pure functions, so they are unit tested without a database.
 */

import { BadRequestException } from '@nestjs/common';
import { findForbiddenSqlPattern } from '../sql/sql-guard';

export const POLICY_COMMANDS = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
export type PolicyCommand = (typeof POLICY_COMMANDS)[number];

/** The roles a policy may be granted to. `public` is the Postgres keyword. */
export const POLICY_ROLES = ['anon', 'authenticated', 'service_role', 'public'] as const;
export type PolicyRole = (typeof POLICY_ROLES)[number];

export const MAX_EXPRESSION_LENGTH = 4000;
export const MAX_IDENTIFIER_LENGTH = 63;

/** Policies are managed for the `public` schema, like indexes and triggers. */
export const POLICY_SCHEMA = 'public';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export interface PolicyDefinition {
  table: string;
  name: string;
  command: PolicyCommand;
  roles: PolicyRole[];
  permissive: boolean;
  using: string | null;
  withCheck: string | null;
}

export interface RlsToggle {
  table: string;
  enabled: boolean;
  /** `true` → FORCE, `false` → NO FORCE, `undefined` → leave as is. */
  force?: boolean;
}

/** Validates a bare identifier and returns it double-quoted. */
export function assertIdentifier(value: unknown, what: string): string {
  if (typeof value !== 'string' || !IDENT_RE.test(value)) {
    throw new BadRequestException(
      `Invalid ${what} name: use letters, digits and underscores, starting with a letter or underscore`,
    );
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new BadRequestException(
      `Invalid ${what} name: longer than ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
  return `"${value}"`;
}

export function qualifyTable(table: string): string {
  return `"${POLICY_SCHEMA}".${assertIdentifier(table, 'table')}`;
}

/**
 * Parentheses must balance outside string literals and quoted identifiers.
 * A literal like `')'` is legal inside an expression, so quotes are skipped.
 */
function parenthesesBalanced(expr: string): boolean {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === quote) {
        // A doubled quote is an escaped quote inside the literal.
        if (expr[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && quote === null;
}

/**
 * Validates one policy expression and returns it trimmed. The expression is
 * inlined into DDL, so anything that could end the statement or hide a token
 * is refused up front; what remains is for Postgres to judge.
 */
export function assertPolicyExpression(value: unknown, what: 'USING' | 'WITH CHECK'): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${what} expression must be a string`);
  }
  const expr = value.trim();
  if (!expr) throw new BadRequestException(`${what} expression is empty`);
  if (expr.length > MAX_EXPRESSION_LENGTH) {
    throw new BadRequestException(
      `${what} expression is longer than ${MAX_EXPRESSION_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARS_RE.test(expr)) {
    throw new BadRequestException(`${what} expression contains control characters`);
  }
  if (expr.includes(';')) {
    throw new BadRequestException(`${what} must be a single expression — remove the ";"`);
  }
  if (expr.includes('--') || expr.includes('/*') || expr.includes('*/')) {
    throw new BadRequestException(`${what} expression must not contain comments`);
  }
  if (!parenthesesBalanced(expr)) {
    throw new BadRequestException(`${what} expression has unbalanced parentheses or quotes`);
  }
  const forbidden = findForbiddenSqlPattern(expr, 'owner');
  if (forbidden) {
    throw new BadRequestException(
      `${what} expression contains a token the console refuses: ${forbidden.trim()}`,
    );
  }
  return expr;
}

function optionalExpression(value: unknown, what: 'USING' | 'WITH CHECK'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return assertPolicyExpression(value, what);
}

/**
 * Turns an untrusted request body into a PolicyDefinition or throws a 400
 * that names the offending field. Command/expression combinations follow
 * what Postgres accepts: INSERT takes only WITH CHECK, SELECT and DELETE take
 * only USING, UPDATE and ALL take USING with an optional WITH CHECK.
 */
export function normalizePolicyDefinition(raw: unknown): PolicyDefinition {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  assertIdentifier(body.table, 'table');
  assertIdentifier(body.name, 'policy');
  const table = body.table as string;
  const name = body.name as string;

  const command = typeof body.command === 'string' ? body.command.trim().toUpperCase() : '';
  if (!(POLICY_COMMANDS as readonly string[]).includes(command)) {
    throw new BadRequestException(
      `Invalid command: expected one of ${POLICY_COMMANDS.join(', ')}`,
    );
  }

  if (!Array.isArray(body.roles) || body.roles.length === 0) {
    throw new BadRequestException('Choose at least one role');
  }
  const roles: PolicyRole[] = [];
  for (const r of body.roles) {
    if (typeof r !== 'string' || !(POLICY_ROLES as readonly string[]).includes(r)) {
      throw new BadRequestException(
        `Invalid role: expected one of ${POLICY_ROLES.join(', ')}`,
      );
    }
    if (!roles.includes(r as PolicyRole)) roles.push(r as PolicyRole);
  }

  let permissive = true;
  if (body.permissive !== undefined) {
    if (typeof body.permissive !== 'boolean') {
      throw new BadRequestException('permissive must be true or false');
    }
    permissive = body.permissive;
  }

  const using = optionalExpression(body.using, 'USING');
  const withCheck = optionalExpression(body.withCheck, 'WITH CHECK');

  if (command === 'INSERT') {
    if (using) throw new BadRequestException('INSERT policies take only a WITH CHECK expression');
    if (!withCheck) throw new BadRequestException('INSERT policies need a WITH CHECK expression');
  } else {
    if (!using) throw new BadRequestException(`${command} policies need a USING expression`);
    if ((command === 'SELECT' || command === 'DELETE') && withCheck) {
      throw new BadRequestException(`${command} policies cannot have a WITH CHECK expression`);
    }
  }

  return {
    table,
    name,
    command: command as PolicyCommand,
    roles,
    permissive,
    using,
    withCheck,
  };
}

export function normalizeRlsToggle(raw: unknown): RlsToggle {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  assertIdentifier(body.table, 'table');
  if (typeof body.enabled !== 'boolean') {
    throw new BadRequestException('enabled must be true or false');
  }
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    throw new BadRequestException('force must be true or false');
  }
  return {
    table: body.table as string,
    enabled: body.enabled,
    force: body.force as boolean | undefined,
  };
}

/** `PUBLIC` is a keyword and must not be quoted; the others are role names. */
export function renderRoles(roles: PolicyRole[]): string {
  return roles.map((r) => (r === 'public' ? 'PUBLIC' : `"${r}"`)).join(', ');
}

export function buildCreatePolicySql(def: PolicyDefinition): string {
  const lines = [
    `CREATE POLICY ${assertIdentifier(def.name, 'policy')} ON ${qualifyTable(def.table)}`,
    `  AS ${def.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'}`,
    `  FOR ${def.command}`,
    `  TO ${renderRoles(def.roles)}`,
  ];
  if (def.using) lines.push(`  USING (${def.using})`);
  if (def.withCheck) lines.push(`  WITH CHECK (${def.withCheck})`);
  return lines.join('\n');
}

export function buildDropPolicySql(table: string, name: string): string {
  return `DROP POLICY ${assertIdentifier(name, 'policy')} ON ${qualifyTable(table)}`;
}

export function buildRlsSql(table: string, enabled: boolean, force?: boolean): string[] {
  const target = qualifyTable(table);
  const statements = [
    `ALTER TABLE ${target} ${enabled ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`,
  ];
  if (force === true) statements.push(`ALTER TABLE ${target} FORCE ROW LEVEL SECURITY`);
  if (force === false) statements.push(`ALTER TABLE ${target} NO FORCE ROW LEVEL SECURITY`);
  return statements;
}

/** The script shown to the user: every statement terminated, one per block. */
export function renderScript(statements: string[]): string {
  return statements.map((s) => `${s};`).join('\n\n');
}
