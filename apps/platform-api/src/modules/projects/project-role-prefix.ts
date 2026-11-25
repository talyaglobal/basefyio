import { BadRequestException } from '@nestjs/common';

/**
 * Named extra database roles: a project picks one short prefix, and its roles are then called
 * `<prefix>_<name>`. Role names are cluster-wide on a shared Postgres, so every rule here runs
 * on the server; the client's value is never trusted.
 */
export const ROLE_PREFIX_RE = /^[a-z][a-z0-9]{2,19}$/;
export const ROLE_NAME_RE = /^[a-z][a-z0-9_]{1,30}$/;
/** A full prefixed role name, `<prefix>_<name>`. */
export const PREFIXED_ROLE_RE = /^[a-z][a-z0-9]{2,19}_[a-z][a-z0-9_]{1,30}$/;
export const MAX_ROLE_NAME_BYTES = 63;

/** Prefixes refused outright: the platform's own roles and Postgres'. */
const RESERVED_PREFIXES = new Set(['anon', 'authenticated', 'service_role', 'kolaybase', 'postgres', 'pg']);
/** Prefixes refused when the value starts with one of these. */
const RESERVED_STARTS = ['pg_', 'kb_', 'kolaybase', 'supabase', 'basefyio'];

/** Why a prefix is refused, or null when it is acceptable. Does not look at the cluster. */
export function rolePrefixProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return 'prefix is required';
  if (!ROLE_PREFIX_RE.test(value)) {
    return 'prefix must be 3-20 characters: a lower-case letter, then lower-case letters or digits';
  }
  if (RESERVED_PREFIXES.has(value) || RESERVED_STARTS.some((s) => value.startsWith(s))) {
    return `prefix "${value}" is reserved`;
  }
  return null;
}

export function assertRolePrefix(value: unknown): string {
  const problem = rolePrefixProblem(value);
  if (problem) throw new BadRequestException(`Invalid role prefix: ${problem}`);
  return value as string;
}

/** `<prefix>_<name>`, checked: the name rule and Postgres' 63-byte identifier limit. */
export function prefixedRoleName(prefix: string, name: unknown): string {
  assertRolePrefix(prefix);
  if (typeof name !== 'string' || !ROLE_NAME_RE.test(name)) {
    throw new BadRequestException(
      'Invalid role name: 2-31 characters, a lower-case letter, then lower-case letters, digits or _',
    );
  }
  const full = `${prefix}_${name}`;
  if (Buffer.byteLength(full, 'utf8') > MAX_ROLE_NAME_BYTES) {
    throw new BadRequestException(`Role name "${full}" is longer than ${MAX_ROLE_NAME_BYTES} bytes`);
  }
  return full;
}

/** Whether `roleName` is `<prefix>_…`. */
export function usesPrefix(prefix: string | null | undefined, roleName: string): boolean {
  return Boolean(prefix) && roleName.startsWith(`${prefix}_`);
}

/** A prefixed name whose prefix passes the static rules (stored values, defence in depth). */
export function isValidPrefixedRoleName(name: string): boolean {
  if (!PREFIXED_ROLE_RE.test(name) || Buffer.byteLength(name, 'utf8') > MAX_ROLE_NAME_BYTES) return false;
  return rolePrefixProblem(name.slice(0, name.indexOf('_'))) === null;
}

/**
 * Cluster roles that block prefix `P`: named `P` or starting with `P_`, except those this project
 * already manages. Compared without LIKE, so `_` is not a wildcard.
 */
export const CLUSTER_PREFIX_ROLES_SQL =
  "SELECT rolname FROM pg_roles WHERE rolname = $1 OR left(rolname, char_length($1) + 1) = $1 || '_'";

export function foreignPrefixRoles(found: readonly string[], ownRoleNames: readonly string[]): string[] {
  const own = new Set(ownRoleNames);
  return found.filter((r) => !own.has(r)).sort();
}
