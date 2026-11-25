import { describe, expect, it, vi } from 'vitest';
import { createRoleBody, findRole, roleRows, runCreateRole, runDropRole, runResetPassword, type DbRole, type DbRolesApi } from './db-roles';

const ROLES: DbRole[] = [
  { id: 'r1', label: 'App', roleName: 'cockpit3_app', kind: 'login', memberships: ['cockpit3_owner'], password: null, createdAt: '' },
  { id: 'r2', label: 'Owner', roleName: 'cockpit3_owner', kind: 'group', memberships: [], password: null, createdAt: '' },
];

function stub(): DbRolesApi {
  return {
    listDbRoles: vi.fn().mockResolvedValue(ROLES),
    createDbRole: vi.fn().mockResolvedValue({ ...ROLES[0], password: 'pw-once' }),
    resetDbRolePassword: vi.fn().mockResolvedValue({ password: 'pw-new' }),
    dropDbRole: vi.fn().mockResolvedValue({ message: 'Extra role removed', warnings: [] }),
  };
}

describe('db roles', () => {
  it('builds the create request: name, label, group, member list', () => {
    expect(createRoleBody('app', {})).toEqual({ label: 'app', name: 'app' });
    expect(createRoleBody('owner', { group: true, label: 'Owner' })).toEqual({ label: 'Owner', name: 'owner', kind: 'group' });
    expect(createRoleBody('app', { memberOf: 'cockpit3_owner, cockpit3_rw' })).toEqual({
      label: 'app', name: 'app', memberOf: ['cockpit3_owner', 'cockpit3_rw'],
    });
    expect(createRoleBody(undefined, { label: 'Worker' })).toEqual({ label: 'Worker' });
    expect(() => createRoleBody(undefined, {})).toThrow(/role name or --label/);
  });

  it('creates through the API and returns the one-time password', async () => {
    const api = stub();
    const role = await runCreateRole(api, 'p1', 'app', {});
    expect(api.createDbRole).toHaveBeenCalledWith('p1', { label: 'app', name: 'app' });
    expect(role.password).toBe('pw-once');
  });

  it('finds a role by role name, id or a unique label', () => {
    expect(findRole(ROLES, 'cockpit3_app').id).toBe('r1');
    expect(findRole(ROLES, 'r2').id).toBe('r2');
    expect(findRole(ROLES, 'Owner').id).toBe('r2');
    expect(() => findRole(ROLES, 'nope')).toThrow(/No database role/);
  });

  it('resets and drops by role id after resolving the name', async () => {
    const api = stub();
    expect((await runResetPassword(api, 'p1', 'cockpit3_app')).password).toBe('pw-new');
    expect(api.resetDbRolePassword).toHaveBeenCalledWith('p1', 'r1');
    await runDropRole(api, 'p1', 'cockpit3_owner');
    expect(api.dropDbRole).toHaveBeenCalledWith('p1', 'r2');
  });

  it('lists rows without any password column', () => {
    expect(roleRows(ROLES)).toEqual([
      ['cockpit3_app', 'login', 'App', 'cockpit3_owner', 'r1'],
      ['cockpit3_owner', 'group', 'Owner', '-', 'r2'],
    ]);
  });
});
