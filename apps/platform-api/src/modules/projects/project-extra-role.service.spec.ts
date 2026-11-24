import { BadRequestException } from '@nestjs/common';
import {
  ProjectExtraRoleService,
  memberOfColumn,
  memberOfFromColumn,
  parseMemberOf,
  parseRoleSettings,
} from './project-extra-role.service';

/** Extra database roles: several memberships, run-time limits that survive a re-provision. */
function build(existingMemberships: string[] = []) {
  const sql: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => {
      sql.push(text);
      if (text.startsWith('SELECT 1 FROM pg_roles')) return { rows: [] };
      if (text.includes('FROM pg_auth_members')) return { rows: existingMemberships.map((rolename) => ({ rolename })) };
      return { rows: [] };
    }),
  };
  const svc: any = Object.create(ProjectExtraRoleService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn() };
  svc.withClient = async (_t: unknown, fn: (c: unknown) => unknown) => fn(client);
  return { svc, sql };
}

const target = { host: 'h', port: 5432, user: 'u', password: 'p' };

describe('parseMemberOf', () => {
  it('reads a name, a comma list, an array or none, in a fixed order', () => {
    expect(parseMemberOf('authenticated')).toEqual(['authenticated']);
    expect(parseMemberOf('authenticated, anon')).toEqual(['anon', 'authenticated']);
    expect(parseMemberOf(['authenticated', 'anon', 'anon'])).toEqual(['anon', 'authenticated']);
    expect(parseMemberOf('none')).toEqual([]);
    expect(parseMemberOf(undefined)).toEqual([]);
    expect(parseMemberOf([])).toEqual([]);
  });

  it('refuses anything that is not a built-in role', () => {
    expect(() => parseMemberOf(['anon', 'postgres'])).toThrow(BadRequestException);
    expect(() => parseMemberOf('kb_user_x')).toThrow(BadRequestException);
  });

  it('stores and reads back the same list', () => {
    expect(memberOfColumn(['anon', 'authenticated'])).toBe('anon,authenticated');
    expect(memberOfColumn([])).toBe('none');
    expect(memberOfFromColumn('anon,authenticated')).toEqual(['anon', 'authenticated']);
    expect(memberOfFromColumn('service_role')).toEqual(['service_role']);
  });
});

describe('parseRoleSettings', () => {
  it('takes milliseconds or units, under either spelling', () => {
    expect(parseRoleSettings({ statementTimeout: '30s', lock_timeout: 5000, idleInTransactionSessionTimeout: '2min' })).toEqual({
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 5000,
      idleInTransactionSessionTimeoutMs: 120_000,
    });
  });

  it('refuses unknown names, bad values and more than a day', () => {
    expect(() => parseRoleSettings({ work_mem: '64MB' })).toThrow(BadRequestException);
    expect(() => parseRoleSettings({ statementTimeout: '30 seconds; drop' })).toThrow(BadRequestException);
    expect(() => parseRoleSettings({ statementTimeout: -1 })).toThrow(BadRequestException);
    expect(() => parseRoleSettings({ statementTimeout: '25h' })).toThrow(BadRequestException);
  });
});

describe('ProjectExtraRoleService.provision', () => {
  it('grants every membership with INHERIT FALSE, SET TRUE and re-applies the limits after RESET ALL', async () => {
    const { svc, sql } = build(['service_role']);
    await svc.provision({
      ...target,
      dbName: 'kb_db',
      roleName: 'kb_xr_0123456789',
      rolePassword: 'pw',
      memberOf: ['anon', 'authenticated'],
      settings: { statementTimeoutMs: 30_000, idleInTransactionSessionTimeoutMs: 60_000, lockTimeoutMs: 5_000 },
    });
    const reset = sql.findIndex((q) => q.includes('RESET ALL'));
    const limits = sql.filter((q) => / SET (statement_timeout|idle_in_transaction_session_timeout|lock_timeout) = \d+$/.test(q));
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(limits).toEqual([
      'ALTER ROLE "kb_xr_0123456789" SET statement_timeout = 30000',
      'ALTER ROLE "kb_xr_0123456789" SET idle_in_transaction_session_timeout = 60000',
      'ALTER ROLE "kb_xr_0123456789" SET lock_timeout = 5000',
    ]);
    expect(sql.indexOf(limits[0])).toBeGreaterThan(reset);
    expect(sql).toContain('REVOKE "service_role" FROM "kb_xr_0123456789" CASCADE');
    expect(sql).toContain('GRANT "anon" TO "kb_xr_0123456789" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE');
    expect(sql).toContain('GRANT "authenticated" TO "kb_xr_0123456789" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE');
  });

  it('still takes a single role name, and none', async () => {
    const one = build();
    await one.svc.provision({ ...target, dbName: 'kb_db', roleName: 'kb_xr_aa', rolePassword: 'pw', memberOf: 'authenticated' });
    expect(one.sql.filter((q) => q.startsWith('GRANT "'))).toEqual([
      'GRANT "authenticated" TO "kb_xr_aa" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE',
    ]);
    const none = build();
    await none.svc.provision({ ...target, dbName: 'kb_db', roleName: 'kb_xr_bb', rolePassword: 'pw', memberOf: 'none' });
    expect(none.sql.filter((q) => q.startsWith('GRANT "'))).toEqual([]);
  });
});

describe('group roles', () => {
  it('memberOf takes the project\'s own groups, and only those', () => {
    const groups = ['kb_xg_aaaaaaaaaa', 'kb_xg_bbbbbbbbbb'];
    expect(parseMemberOf(['kb_xg_bbbbbbbbbb', 'anon'], groups)).toEqual(['anon', 'kb_xg_bbbbbbbbbb']);
    expect(() => parseMemberOf(['kb_xg_cccccccccc'], groups)).toThrow(BadRequestException);
    expect(() => parseMemberOf(['kb_user_0123456789'], groups)).toThrow(BadRequestException);
    expect(memberOfFromColumn('authenticated,kb_xg_aaaaaaaaaa')).toEqual(['authenticated', 'kb_xg_aaaaaaaaaa']);
  });

  it('a login role joins a group as an ordinary member, a built-in role only through SET ROLE', async () => {
    const { svc, sql } = build();
    await svc.provision({
      ...target, dbName: 'kb_db', roleName: 'kb_xr_cc', rolePassword: 'pw',
      memberOf: ['authenticated', 'kb_xg_aaaaaaaaaa'],
    });
    expect(sql).toContain('GRANT "authenticated" TO "kb_xr_cc" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE');
    expect(sql).toContain('GRANT "kb_xg_aaaaaaaaaa" TO "kb_xr_cc" WITH INHERIT TRUE, SET TRUE, ADMIN FALSE');
  });

  it('creates a NOLOGIN group without rights of its own, and lets the owner SET ROLE to it', async () => {
    const { svc, sql } = build(['service_role']);
    await svc.provisionGroup({ ...target, roleName: 'kb_xg_0123456789', ownerRole: 'kb_user_owner' });
    const create = sql.find((q) => q.startsWith('CREATE ROLE "kb_xg_0123456789"'))!;
    for (const attr of ['NOLOGIN', 'NOSUPERUSER', 'NOCREATEROLE', 'NOBYPASSRLS', 'NOINHERIT']) expect(create).toContain(attr);
    expect(sql).toContain('REVOKE "service_role" FROM "kb_xg_0123456789" CASCADE');
    expect(sql).toContain('GRANT "kb_xg_0123456789" TO "kb_user_owner" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE');
  });

  it('refuses a name that is not a generated group name', async () => {
    const { svc } = build();
    await expect(svc.provisionGroup({ ...target, roleName: 'postgres', ownerRole: 'kb_user_owner' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
