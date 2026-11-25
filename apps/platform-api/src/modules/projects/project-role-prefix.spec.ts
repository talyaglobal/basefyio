import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertRolePrefix,
  foreignPrefixRoles,
  isValidPrefixedRoleName,
  prefixedRoleName,
  rolePrefixProblem,
  usesPrefix,
} from './project-role-prefix';
import { ProjectExtraRoleService, parseMemberOf } from './project-extra-role.service';
import { MAX_EXTRA_ROLES_PER_KIND, ProjectsService } from './projects.service';

describe('role prefix rules', () => {
  it('accepts 3-20 lower-case letters and digits starting with a letter', () => {
    for (const ok of ['cockpit3', 'abc', 'a1b2c3', 'x'.repeat(20), 'pgadmin', 'kbx']) {
      expect(rolePrefixProblem(ok)).toBeNull();
    }
  });

  it('refuses the wrong shape: too short, too long, upper case, digits first, underscores, other characters', () => {
    for (const bad of ['', 'ab', 'x'.repeat(21), 'Cockpit', 'COCKPIT', '3abc', 'my_app', 'my-app', 'my app', 'äbc', ' abc']) {
      expect(rolePrefixProblem(bad)).not.toBeNull();
    }
    for (const bad of [undefined, null, 42, ['abc'], { p: 'abc' }]) expect(rolePrefixProblem(bad)).not.toBeNull();
    expect(() => assertRolePrefix('Cockpit3')).toThrow(BadRequestException);
  });

  it('refuses the reserved names and starts', () => {
    for (const bad of ['anon', 'authenticated', 'kolaybase', 'postgres', 'pg', 'service_role']) {
      expect(rolePrefixProblem(bad)).not.toBeNull();
    }
    for (const bad of ['kolaybasex', 'supabase', 'supabase1', 'basefyio', 'basefyioapp', 'kolaybase2']) {
      expect(rolePrefixProblem(bad)).toMatch(/reserved/);
    }
  });

  it('builds <prefix>_<name> and checks the name', () => {
    expect(prefixedRoleName('cockpit3', 'app')).toBe('cockpit3_app');
    expect(prefixedRoleName('cockpit3', 'owner_rw')).toBe('cockpit3_owner_rw');
    expect(prefixedRoleName('x'.repeat(20), 'a' + 'b'.repeat(30)).length).toBe(52);
    for (const bad of ['a', 'App', '1app', 'app-x', 'a'.repeat(32), '', 'app;drop', '"app"']) {
      expect(() => prefixedRoleName('cockpit3', bad)).toThrow(BadRequestException);
    }
    expect(() => prefixedRoleName('pg', 'app')).toThrow(BadRequestException);
  });

  it('recognises names under a prefix and stored prefixed names', () => {
    expect(usesPrefix('cockpit3', 'cockpit3_app')).toBe(true);
    expect(usesPrefix('cockpit3', 'cockpit30_app')).toBe(false);
    expect(usesPrefix(null, 'cockpit3_app')).toBe(false);
    expect(isValidPrefixedRoleName('cockpit3_owner')).toBe(true);
    for (const bad of ['postgres', 'kb_user_x', 'authenticated_x', 'supabase_admin', 'pg_read_all_data', 'kolaybase_x']) {
      expect(isValidPrefixedRoleName(bad)).toBe(false);
    }
  });

  it('a cluster role blocks a prefix unless this project manages it', () => {
    expect(foreignPrefixRoles(['cockpit3', 'cockpit3_app'], ['cockpit3_app'])).toEqual(['cockpit3']);
    expect(foreignPrefixRoles(['cockpit3_app'], ['cockpit3_app'])).toEqual([]);
  });
});

describe('memberOf with named group roles', () => {
  it("takes the project's own prefixed groups and nothing else", () => {
    expect(parseMemberOf(['cockpit3_owner'], ['cockpit3_owner'])).toEqual(['cockpit3_owner']);
    expect(() => parseMemberOf(['other1_owner'], ['cockpit3_owner'])).toThrow(BadRequestException);
    expect(() => parseMemberOf(['kb_user_abc'], ['kb_user_abc'])).toThrow(BadRequestException);
    expect(() => parseMemberOf(['postgres'], 'any')).toThrow(BadRequestException);
  });
});

/* ───────────── service: prefix, naming, limits, collisions, audit, teardown ───────────── */

const PROJECT = {
  id: 'p1', teamId: 't1', dbName: 'kb_db', dbUser: 'kb_user_owner', dbHost: 'h', dbPort: 5432, rolePrefix: null as string | null,
};
const TARGET = { host: 'h', port: 5432, user: 'admin', password: 'admin-pw' };

function build(opts: {
  project?: Partial<typeof PROJECT>;
  roles?: Array<{ id?: string; roleName: string; kind?: string; memberOf?: string; label?: string; password?: string }>;
  clusterRoles?: string[];
  otherProjectPrefix?: string | null;
} = {}) {
  const project = { ...PROJECT, ...opts.project };
  const roles = (opts.roles ?? []).map((r, i) => ({
    id: r.id ?? `r${i}`, projectId: project.id, label: r.label ?? r.roleName, roleName: r.roleName,
    kind: r.kind ?? 'login', memberOf: r.memberOf ?? 'none', password: r.password ?? 'stored-secret', settings: {}, createdAt: new Date(),
  }));
  const created: any[] = [];
  const activity: any[] = [];
  const prisma: any = {
    project: {
      findFirst: jest.fn(async () => (opts.otherProjectPrefix ? { id: 'p2' } : null)),
      update: jest.fn(async ({ data }: any) => Object.assign(project, data)),
    },
    projectExtraRole: {
      findMany: jest.fn(async ({ where, select }: any) =>
        roles
          .filter((r) => (!where?.projectId || r.projectId === where.projectId) && (!where?.kind || r.kind === where.kind))
          .map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (r as any)[k]])) : r)),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        roles.find((r) => (!where.id || r.id === where.id) && (!where.roleName || r.roleName === where.roleName)) ?? null,
      ),
      count: jest.fn(async ({ where }: any) => roles.filter((r) => r.kind === where.kind).length),
      create: jest.fn(async ({ data, select }: any) => {
        const row = { id: 'new', createdAt: new Date(), settings: {}, ...data };
        created.push(row);
        return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
      }),
      update: jest.fn(async ({ data }: any) => ({ ...roles[0], ...data })),
      delete: jest.fn(async () => undefined),
    },
  };
  const extraRole: any = {
    provision: jest.fn(async () => undefined),
    provisionGroup: jest.fn(async () => undefined),
    setPassword: jest.fn(async () => undefined),
    drop: jest.fn(async () => ({ warnings: [] })),
    rolesMatchingPrefix: jest.fn(async () => opts.clusterRoles ?? []),
  };
  const svc: any = Object.create(ProjectsService.prototype);
  Object.assign(svc, {
    prisma,
    extraRole,
    activity: { append: jest.fn(async (_p: string, e: any) => activity.push(e)) },
    provisioning: { resolveAdminTarget: () => TARGET },
    pgbouncer: { regenerateConfig: jest.fn(async () => undefined) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    loadProjectForDbCredentials: jest.fn(async () => project),
    sharedAdminTarget: () => TARGET,
  });
  return { svc, prisma, extraRole, created, activity, project };
}

describe('PUT db-role-prefix', () => {
  it('sets a free prefix and records who set it', async () => {
    const { svc, project, activity } = build();
    await expect(svc.setRolePrefix('p1', 'u1', 'cockpit3')).resolves.toEqual({ prefix: 'cockpit3', locked: false });
    expect(project.rolePrefix).toBe('cockpit3');
    expect(activity[0]).toMatchObject({ userId: 'u1', metadata: { event: 'db_role.prefix_set', prefix: 'cockpit3' } });
  });

  it('409 when another project holds it, or a cluster role not managed here is P or P_…', async () => {
    await expect(build({ otherProjectPrefix: 'cockpit3' }).svc.setRolePrefix('p1', 'u1', 'cockpit3')).rejects.toBeInstanceOf(ConflictException);
    for (const clusterRoles of [['cockpit3'], ['cockpit3_admin']]) {
      const { svc, prisma } = build({ clusterRoles });
      await expect(svc.setRolePrefix('p1', 'u1', 'cockpit3')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.project.update).not.toHaveBeenCalled();
    }
  });

  it('400 for a reserved or malformed prefix, without touching the cluster', async () => {
    for (const bad of ['pg', 'kolaybase', 'Cockpit3', 'kb_app', 'supabaseapp', 'a']) {
      const { svc, extraRole } = build();
      await expect(svc.setRolePrefix('p1', 'u1', bad)).rejects.toBeInstanceOf(BadRequestException);
      expect(extraRole.rolesMatchingPrefix).not.toHaveBeenCalled();
    }
  });

  it('is immutable once a role uses it, and idempotent for the same value', async () => {
    const locked = build({ project: { rolePrefix: 'cockpit3' }, roles: [{ roleName: 'cockpit3_app' }] });
    await expect(locked.svc.setRolePrefix('p1', 'u1', 'other1')).rejects.toBeInstanceOf(ConflictException);
    await expect(locked.svc.setRolePrefix('p1', 'u1', 'cockpit3')).resolves.toEqual({ prefix: 'cockpit3', locked: true });
    const unused = build({ project: { rolePrefix: 'cockpit3' }, roles: [{ roleName: 'kb_xr_0123456789' }] });
    await expect(unused.svc.setRolePrefix('p1', 'u1', 'other1')).resolves.toEqual({ prefix: 'other1', locked: false });
  });
});

describe('POST db-extra-roles with a name', () => {
  it('400 when the project has no prefix yet', async () => {
    const { svc, extraRole } = build();
    await expect(svc.createExtraRole('p1', 'u1', 'App', 'none', undefined, undefined, 'app')).rejects.toThrow(/Set a role prefix first/);
    expect(extraRole.provision).not.toHaveBeenCalled();
  });

  it('creates <prefix>_<name>, create-only, returns the password once and audits without it', async () => {
    const { svc, extraRole, activity } = build({ project: { rolePrefix: 'cockpit3' }, roles: [{ roleName: 'cockpit3_owner', kind: 'group' }] });
    const out = await svc.createExtraRole('p1', 'u1', 'App', ['cockpit3_owner'], undefined, undefined, 'app');
    expect(out.roleName).toBe('cockpit3_app');
    expect(typeof out.password).toBe('string');
    expect(extraRole.provision).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'cockpit3_app', mustNotExist: true, memberOf: ['cockpit3_owner'] }));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ userId: 'u1', metadata: { event: 'db_role.created', roleName: 'cockpit3_app' } });
    expect(JSON.stringify(activity)).not.toContain(out.password);
  });

  it('a named group is <prefix>_<name>, created only if free', async () => {
    const { svc, extraRole } = build({ project: { rolePrefix: 'cockpit3' } });
    const out = await svc.createExtraRole('p1', 'u1', 'Owner', 'none', undefined, 'group', 'owner');
    expect(out).toMatchObject({ roleName: 'cockpit3_owner', kind: 'group', password: null });
    expect(extraRole.provisionGroup).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'cockpit3_owner', ownerRole: 'kb_user_owner', mustNotExist: true }));
  });

  it('a named role never joins anon, authenticated, service_role, the owner or another project\'s role', async () => {
    for (const memberOf of ['anon', 'authenticated', 'service_role', 'kb_user_owner', 'other1_owner', 'postgres']) {
      const { svc, extraRole, created } = build({ project: { rolePrefix: 'cockpit3' } });
      await expect(svc.createExtraRole('p1', 'u1', 'App', memberOf, undefined, undefined, 'app')).rejects.toBeInstanceOf(BadRequestException);
      expect(extraRole.provision).not.toHaveBeenCalled();
      expect(created).toHaveLength(0);
    }
  });

  it('409 and nothing stored when the cluster already has that role', async () => {
    const { svc, extraRole, created, activity } = build({ project: { rolePrefix: 'cockpit3' } });
    extraRole.provision.mockRejectedValueOnce(new ConflictException('A database role named "cockpit3_app" already exists'));
    await expect(svc.createExtraRole('p1', 'u1', 'App', 'none', undefined, undefined, 'app')).rejects.toBeInstanceOf(ConflictException);
    expect(created).toHaveLength(0);
    expect(activity).toHaveLength(0);
  });

  it('409 when the platform already records that role name', async () => {
    const { svc, extraRole } = build({ project: { rolePrefix: 'cockpit3' }, roles: [{ roleName: 'cockpit3_app' }] });
    await expect(svc.createExtraRole('p1', 'u1', 'App', 'none', undefined, undefined, 'app')).rejects.toBeInstanceOf(ConflictException);
    expect(extraRole.provision).not.toHaveBeenCalled();
  });

  it(`refuses an eleventh login role (limit ${MAX_EXTRA_ROLES_PER_KIND})`, async () => {
    const roles = Array.from({ length: MAX_EXTRA_ROLES_PER_KIND }, (_, i) => ({ roleName: `cockpit3_r${i}` }));
    const { svc, extraRole } = build({ project: { rolePrefix: 'cockpit3' }, roles });
    await expect(svc.createExtraRole('p1', 'u1', 'App', 'none', undefined, undefined, 'app')).rejects.toThrow(/Maximum of 10/);
    expect(extraRole.provision).not.toHaveBeenCalled();
  });

  it('without a name a project keeps the generated kb_xr_ name and the built-in memberships', async () => {
    const { svc, extraRole } = build({ project: { rolePrefix: 'cockpit3' } });
    const out = await svc.createExtraRole('p1', 'u1', 'Worker', 'authenticated');
    expect(out.roleName).toMatch(/^kb_xr_[0-9a-f]{10}$/);
    expect(extraRole.provision).toHaveBeenCalledWith(expect.objectContaining({ memberOf: ['authenticated'], mustNotExist: false }));
  });
});

describe('passwords stay out of lists, updates and audit entries', () => {
  it('GET list has no password', async () => {
    const { svc, prisma } = build({ roles: [{ roleName: 'kb_xr_0123456789', password: 'stored-secret' }] });
    const list = await svc.listExtraRoles('p1', 'u1');
    expect(prisma.projectExtraRole.findMany.mock.calls[0][0].select.password).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain('stored-secret');
    expect(list[0].password).toBeNull();
  });

  it('rotate answers the new password once and audits the role name only', async () => {
    const { svc, activity } = build({ roles: [{ id: 'r0', roleName: 'kb_xr_0123456789' }] });
    const { password } = await svc.rotateExtraRolePassword('p1', 'u1', 'r0');
    expect(activity[0]).toMatchObject({ metadata: { event: 'db_role.password_rotated', roleName: 'kb_xr_0123456789' } });
    expect(JSON.stringify(activity)).not.toContain(password);
  });

  it('update and drop are audited with the role name', async () => {
    const { svc, activity, extraRole } = build({ roles: [{ id: 'r0', roleName: 'kb_xr_0123456789' }] });
    await svc.updateExtraRole('p1', 'u1', 'r0', { memberOf: 'anon' });
    await svc.dropExtraRole('p1', 'u1', 'r0');
    expect(activity.map((a) => a.metadata.event)).toEqual(['db_role.updated', 'db_role.dropped']);
    expect(JSON.stringify(activity)).not.toContain('stored-secret');
    expect(extraRole.drop).toHaveBeenCalledWith(expect.objectContaining({ reassignTo: 'kb_user_owner', dbName: 'kb_db' }));
  });
});

describe('project teardown', () => {
  it('drops every extra role, login roles before groups, handing what they own to the owner', async () => {
    const { svc, extraRole } = build({
      roles: [{ roleName: 'cockpit3_owner', kind: 'group' }, { roleName: 'cockpit3_app' }],
    });
    await svc.dropExtraRolesQuietly(PROJECT);
    expect(extraRole.drop.mock.calls.map((c: any[]) => [c[0].roleName, c[0].reassignTo, c[0].dbName])).toEqual([
      ['cockpit3_app', 'kb_user_owner', 'kb_db'],
      ['cockpit3_owner', 'kb_user_owner', 'kb_db'],
    ]);
  });
});

describe('ProjectExtraRoleService create-only provisioning', () => {
  function sqlClient(existing: boolean) {
    const sql: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        sql.push(text);
        if (text.startsWith('SELECT 1 FROM pg_roles')) return { rows: existing ? [{}] : [] };
        return { rows: [] };
      }),
    };
    const svc: any = Object.create(ProjectExtraRoleService.prototype);
    svc.logger = { log: jest.fn(), warn: jest.fn() };
    svc.withClient = async (_t: unknown, fn: (c: unknown) => unknown) => fn(client);
    return { svc, sql };
  }

  it('creates inside one transaction with the fixed attributes and CONNECT on the project database only', async () => {
    const { svc, sql } = sqlClient(false);
    await svc.provision({ ...TARGET, dbName: 'kb_db', roleName: 'cockpit3_app', rolePassword: 'pw', memberOf: ['cockpit3_owner'], mustNotExist: true });
    expect(sql[0]).toBe('BEGIN');
    expect(sql[sql.length - 1]).toBe('COMMIT');
    expect(sql).toContain(`CREATE ROLE "cockpit3_app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD 'pw'`);
    expect(sql.filter((q) => q.startsWith('GRANT CONNECT'))).toEqual(['GRANT CONNECT ON DATABASE "kb_db" TO "cockpit3_app"']);
    expect(sql).toContain('GRANT "cockpit3_owner" TO "cockpit3_app" WITH INHERIT TRUE, SET TRUE, ADMIN FALSE');
  });

  it('409 and a rollback when the name exists: no ALTER of someone else\'s role', async () => {
    const { svc, sql } = sqlClient(true);
    await expect(
      svc.provision({ ...TARGET, dbName: 'kb_db', roleName: 'cockpit3_app', rolePassword: 'pw', memberOf: [], mustNotExist: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sql.some((q) => q.startsWith('ALTER ROLE'))).toBe(false);
    expect(sql[sql.length - 1]).toBe('ROLLBACK');
    const group = sqlClient(true);
    await expect(
      group.svc.provisionGroup({ ...TARGET, roleName: 'cockpit3_owner', ownerRole: 'kb_user_owner', mustNotExist: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(group.sql.some((q) => q.startsWith('ALTER ROLE'))).toBe(false);
  });

  it('refuses a group name that is neither generated nor a valid prefixed name', async () => {
    const { svc } = sqlClient(false);
    for (const bad of ['postgres', 'authenticated_x', 'kolaybase_x', 'pg_monitor']) {
      await expect(svc.provisionGroup({ ...TARGET, roleName: bad, ownerRole: 'kb_user_owner' })).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
