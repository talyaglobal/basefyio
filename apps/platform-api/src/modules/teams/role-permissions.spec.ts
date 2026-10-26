import { ForbiddenException, Logger } from '@nestjs/common';
import {
  ADMIN_DEFAULTS,
  MEMBER_DEFAULTS,
  PERM_KEYS,
  ensureDefaultRolePermissions,
  grantedByRole,
  permissionMode,
  requireRolePermission,
  roleAllows,
} from './role-permissions';

function makeDb(row: Record<string, unknown> | null) {
  return {
    teamRolePermission: {
      findUnique: jest.fn().mockResolvedValue(row),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('role permission defaults', () => {
  it('cover every key for both roles', () => {
    for (const key of PERM_KEYS) {
      expect(typeof ADMIN_DEFAULTS[key]).toBe('boolean');
      expect(typeof MEMBER_DEFAULTS[key]).toBe('boolean');
    }
    expect(PERM_KEYS).toContain('canResetDbPassword');
  });

  it('seeds ADMIN and MEMBER rows without touching existing ones', async () => {
    const db = makeDb(null);
    await ensureDefaultRolePermissions(db as any, 't1');
    expect(db.teamRolePermission.upsert).toHaveBeenCalledTimes(2);
    expect(db.teamRolePermission.upsert.mock.calls[0][0].update).toEqual({});
    expect(db.teamRolePermission.upsert.mock.calls[0][0].create).toMatchObject({ teamId: 't1', role: 'ADMIN', canViewBilling: true });
  });
});

describe('roleAllows', () => {
  it('always allows an OWNER without reading a row', async () => {
    const db = makeDb(null);
    await expect(roleAllows(db as any, 't1', 'OWNER', 'canManageBilling')).resolves.toBe(true);
    expect(db.teamRolePermission.findUnique).not.toHaveBeenCalled();
  });

  it('reads the stored row when there is one', async () => {
    const db = makeDb({ canCreateProjects: false });
    await expect(roleAllows(db as any, 't1', 'MEMBER', 'canCreateProjects')).resolves.toBe(false);
  });

  it('falls back to the role defaults the dashboard shows', async () => {
    const db = makeDb(null);
    await expect(roleAllows(db as any, 't1', 'ADMIN', 'canDeleteProjects')).resolves.toBe(true);
    await expect(roleAllows(db as any, 't1', 'MEMBER', 'canViewBilling')).resolves.toBe(false);
    await expect(roleAllows(db as any, 't1', 'MEMBER', 'canCreateProjects')).resolves.toBe(true);
  });
});

describe('ORG_PERMISSIONS_ENFORCED', () => {
  const original = process.env.ORG_PERMISSIONS_ENFORCED;
  afterEach(() => {
    if (original === undefined) delete process.env.ORG_PERMISSIONS_ENFORCED;
    else process.env.ORG_PERMISSIONS_ENFORCED = original;
  });

  it('defaults to log and tolerates case and spaces', () => {
    delete process.env.ORG_PERMISSIONS_ENFORCED;
    expect(permissionMode()).toBe('log');
    process.env.ORG_PERMISSIONS_ENFORCED = ' Enforce ';
    expect(permissionMode()).toBe('enforce');
    process.env.ORG_PERMISSIONS_ENFORCED = 'OFF';
    expect(permissionMode()).toBe('off');
    process.env.ORG_PERMISSIONS_ENFORCED = 'yes';
    expect(permissionMode()).toBe('log');
  });

  it('off: grants nothing beyond the old rules and denies nothing', async () => {
    process.env.ORG_PERMISSIONS_ENFORCED = 'off';
    const db = makeDb({ canDeleteProjects: true, canCreateProjects: false });
    await expect(grantedByRole(db as any, 't1', 'ADMIN', 'canDeleteProjects')).resolves.toBe(false);
    const logger = { warn: jest.fn() } as unknown as Logger;
    await expect(
      requireRolePermission(db as any, logger, { teamId: 't1', userId: 'u1', role: 'MEMBER', key: 'canCreateProjects' }),
    ).resolves.toBeUndefined();
    expect((logger as any).warn).not.toHaveBeenCalled();
  });

  it('log: grants, and logs a denial instead of applying it', async () => {
    process.env.ORG_PERMISSIONS_ENFORCED = 'log';
    const db = makeDb({ canDeleteProjects: true, canCreateProjects: false });
    await expect(grantedByRole(db as any, 't1', 'ADMIN', 'canDeleteProjects')).resolves.toBe(true);
    const logger = { warn: jest.fn() } as unknown as Logger;
    await expect(
      requireRolePermission(db as any, logger, { teamId: 't1', userId: 'u1', role: 'MEMBER', key: 'canCreateProjects' }),
    ).resolves.toBeUndefined();
    expect((logger as any).warn).toHaveBeenCalledWith(expect.stringContaining('canCreateProjects would deny u1 (MEMBER) in team t1'));
  });

  it('enforce: denies with a 403', async () => {
    process.env.ORG_PERMISSIONS_ENFORCED = 'enforce';
    const db = makeDb({ canCreateProjects: false });
    const logger = { warn: jest.fn() } as unknown as Logger;
    await expect(
      requireRolePermission(db as any, logger, { teamId: 't1', userId: 'u1', role: 'MEMBER', key: 'canCreateProjects' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never denies an OWNER in any mode', async () => {
    process.env.ORG_PERMISSIONS_ENFORCED = 'enforce';
    const db = makeDb({ canCreateProjects: false });
    const logger = { warn: jest.fn() } as unknown as Logger;
    await expect(
      requireRolePermission(db as any, logger, { teamId: 't1', userId: 'u1', role: 'OWNER', key: 'canCreateProjects' }),
    ).resolves.toBeUndefined();
  });
});
