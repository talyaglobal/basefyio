import { ForbiddenException, Logger } from '@nestjs/common';
import type { PrismaClient, TeamMemberRole } from '@prisma/client';

/**
 * The per-role permission flags and their defaults, shared by the teams
 * service (which reads and edits them), the organization bootstrap (which
 * seeds them for a new personal organization), the backfill script and the
 * services that enforce them. One copy, so a new flag cannot be seeded in
 * one place and forgotten in another.
 */
export const PERM_KEYS = [
  'canRenameTeam', 'canInviteMembers', 'canRemoveMembers', 'canManageIntegrations',
  'canCreateProjects', 'canDeleteProjects', 'canRestoreProjects', 'canMoveProjects',
  'canResetDbPassword', 'canViewBilling', 'canManageBilling',
] as const;

export type PermissionKey = (typeof PERM_KEYS)[number];

export const ADMIN_DEFAULTS: Record<PermissionKey, boolean> = {
  canRenameTeam: true, canInviteMembers: true, canRemoveMembers: true, canManageIntegrations: true,
  canCreateProjects: true, canDeleteProjects: true, canRestoreProjects: true, canMoveProjects: true,
  canResetDbPassword: false, canViewBilling: true, canManageBilling: false,
};

export const MEMBER_DEFAULTS: Record<PermissionKey, boolean> = {
  canRenameTeam: false, canInviteMembers: false, canRemoveMembers: false, canManageIntegrations: false,
  canCreateProjects: true, canDeleteProjects: false, canRestoreProjects: false, canMoveProjects: false,
  canResetDbPassword: false, canViewBilling: false, canManageBilling: false,
};

type RolePermissionStore = Pick<PrismaClient, 'teamRolePermission'>;

/** Create the ADMIN and MEMBER rows with their defaults; rows that exist are left as they are. */
export async function ensureDefaultRolePermissions(db: RolePermissionStore, teamId: string): Promise<void> {
  for (const [role, defaults] of [['ADMIN', ADMIN_DEFAULTS], ['MEMBER', MEMBER_DEFAULTS]] as const) {
    await db.teamRolePermission.upsert({
      where: { teamId_role: { teamId, role } },
      update: {},
      create: { teamId, role, ...defaults },
    });
  }
}

/**
 * What the stored flags say for this role: the team's row when it has one,
 * the role defaults otherwise (the same ones the dashboard displays), and
 * always yes for an OWNER.
 */
export async function roleAllows(db: RolePermissionStore, teamId: string, role: TeamMemberRole, key: PermissionKey): Promise<boolean> {
  if (role === 'OWNER') return true;
  const row = await db.teamRolePermission.findUnique({ where: { teamId_role: { teamId, role } } });
  if (row) return (row as unknown as Record<string, unknown>)[key] === true;
  const defaults = role === 'ADMIN' ? ADMIN_DEFAULTS : MEMBER_DEFAULTS;
  return defaults[key];
}

/**
 * ORG_PERMISSIONS_ENFORCED decides how far the stored flags reach for the
 * actions that ignored them until now (creating, deleting, restoring and
 * moving projects; viewing and managing billing).
 *
 *   off     — exactly the old rules: owners and creators, nobody else
 *   log     — the flags grant what they promise; where they would take an
 *             action away, the denial is logged and the action allowed
 *   enforce — the flags grant and deny
 *
 * Unset means `log`: a week of logs says who would be denied before anyone is.
 */
export type PermissionMode = 'off' | 'log' | 'enforce';

export function permissionMode(): PermissionMode {
  const v = (process.env.ORG_PERMISSIONS_ENFORCED || 'log').trim().toLowerCase();
  return v === 'off' || v === 'enforce' ? v : 'log';
}

/**
 * Widening: an action owners (or creators) could always do; the stored flag
 * may grant it to a role too. Off → nothing changes for anyone.
 */
export async function grantedByRole(db: RolePermissionStore, teamId: string, role: TeamMemberRole, key: PermissionKey): Promise<boolean> {
  if (permissionMode() === 'off') return false;
  return roleAllows(db, teamId, role, key);
}

/**
 * Narrowing: an action every member could do; the stored flag may now deny
 * it. In `log` mode the denial is recorded and the action goes ahead.
 */
export async function requireRolePermission(
  db: RolePermissionStore,
  logger: Logger,
  input: { teamId: string; userId: string; role: TeamMemberRole; key: PermissionKey },
): Promise<void> {
  const mode = permissionMode();
  if (mode === 'off') return;
  if (await roleAllows(db, input.teamId, input.role, input.key)) return;
  if (mode === 'log') {
    logger.warn(
      `Permission ${input.key} would deny ${input.userId} (${input.role}) in team ${input.teamId} — ORG_PERMISSIONS_ENFORCED=log, allowed`,
    );
    return;
  }
  throw new ForbiddenException(`Your role does not have the "${input.key}" permission in this organization`);
}
