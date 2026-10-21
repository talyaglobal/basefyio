const clientQuery = jest.fn();
const clientConnect = jest.fn().mockResolvedValue(undefined);
const clientEnd = jest.fn().mockResolvedValue(undefined);
const clientCtor = jest.fn();
jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation((opts: unknown) => {
    clientCtor(opts);
    return { connect: clientConnect, query: clientQuery, end: clientEnd };
  }),
  Pool: jest.fn(),
}));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: any[]) => execFileMock(...args),
}));

jest.mock('../../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../project-activity.service', () => ({
  ProjectActivityService: class {},
  ProjectActivityKind: {
    PROJECT_UPDATED: 'project.updated',
    PROJECT_BRANCH_CREATED: 'project.branch_created',
    PROJECT_BRANCH_DELETED: 'project.branch_deleted',
  },
}));
jest.mock('../../entitlement/entitlement.service', () => ({ EntitlementService: class {} }));
jest.mock('../../../common/realtime/realtime-events.service', () => ({ RealtimeEventsService: class {} }));

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectBranchService, previewBranchOf } from './project-branch.service';

const parentRow = {
  id: 'parent',
  name: 'Shop',
  slug: 'shop',
  status: 'ACTIVE',
  databaseType: 'RELATIONAL',
  parentProjectId: null,
  teamId: 't1',
  dbHost: 'postgres',
  dbPort: 5432,
  dbUser: 'u_parent',
  dbPassword: 'pw_parent',
  dbName: 'db_parent',
};

const branchRow = {
  id: 'child',
  name: 'Shop [pr-42]',
  slug: 'shop-pr-42',
  status: 'ACTIVE',
  teamId: 't1',
  createdAt: new Date('2026-10-20T10:00:00Z'),
  dbHost: 'postgres',
  dbPort: 5432,
  dbUser: 'u_child',
  dbPassword: 'pw_child',
  dbName: 'db_child',
  parentProjectId: 'parent',
  branchName: 'pr-42',
  branchDataMode: 'schema',
  branchSyncStatus: 'pending',
  branchSyncError: null,
};

function fakes(overrides: { parent?: Partial<typeof parentRow> | null; live?: number; dedicated?: boolean; taken?: any } = {}) {
  const parent = overrides.parent === null ? null : { ...parentRow, ...(overrides.parent ?? {}) };
  const prisma = {
    project: {
      findUnique: jest.fn().mockResolvedValue(parent),
      count: jest.fn().mockResolvedValue(overrides.live ?? 0),
      findFirst: jest.fn().mockResolvedValue(overrides.taken ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    projectInfrastructure: { findUnique: jest.fn().mockResolvedValue(overrides.dedicated ? { projectId: 'parent' } : null) },
    teamMember: { findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]) },
  };
  const projectsService = {
    findOne: jest.fn().mockResolvedValue({ id: 'parent', teamId: 't1' }),
    create: jest.fn().mockResolvedValue(branchRow),
    ensureRlsBootstrap: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue({ message: 'Project deleted' }),
  };
  const entitlement = { assertCan: jest.fn().mockResolvedValue(undefined) };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const realtime = { publish: jest.fn().mockResolvedValue(undefined) };
  const svc = new ProjectBranchService(prisma as any, projectsService as any, entitlement as any, activity as any, realtime as any);
  return { svc, prisma, projectsService, entitlement, activity, realtime };
}

/** execFile that succeeds for every command unless `fail` matches the binary. */
function execOk(fail?: { cmd: string; code?: number; stderr?: string }) {
  execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: (e: any, r?: any) => void) => {
    if (fail && cmd === fail.cmd) {
      cb(Object.assign(new Error(`${cmd} failed`), { code: fail.code ?? 1, stderr: fail.stderr ?? '' }));
    } else {
      cb(null, { stdout: '', stderr: '' });
    }
  });
}

const argsOf = (cmd: string): string[] => {
  const call = execFileMock.mock.calls.find((c) => c[0] === cmd);
  if (!call) throw new Error(`${cmd} was not run`);
  return call[1];
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.BRANCH_LIMIT_PER_PROJECT;
  delete process.env.BRANCH_MAX_DB_MB;
  execOk();
  clientQuery.mockResolvedValue({ rows: [{ bytes: String(50 * 1024 * 1024) }] });
});

describe('previewBranchOf', () => {
  it('is null for an ordinary project and the full shape for a branch', () => {
    expect(previewBranchOf({ parentProjectId: null, branchName: null })).toBeNull();
    expect(previewBranchOf({ ...branchRow, parent: { id: 'parent', name: 'Shop', slug: 'shop' } })).toEqual({
      parentProjectId: 'parent',
      parentName: 'Shop',
      parentSlug: 'shop',
      branchName: 'pr-42',
      dataMode: 'schema',
      syncStatus: 'pending',
      syncError: null,
    });
  });
});

describe('ProjectBranchService.createPreviewBranch — validation', () => {
  it.each(['Feature/X', '-a', 'a', 'x'.repeat(41), 'UPPER', 'with space'])('rejects the name %p', async (name) => {
    const { svc, projectsService } = fakes();
    await expect(svc.createPreviewBranch('parent', 'u1', { name })).rejects.toBeInstanceOf(BadRequestException);
    expect(projectsService.create).not.toHaveBeenCalled();
  });

  it('refuses a NoSQL parent, a branch of a branch, an inactive parent and a dedicated database', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ parent: { databaseType: 'NOSQL' } }, /PostgreSQL projects only/],
      [{ parent: { parentProjectId: 'grand' } }, /cannot be branched again/],
      [{ parent: { status: 'PAUSED' } }, /active project/],
      [{ dedicated: true }, /dedicated database/],
    ];
    for (const [over, re] of cases) {
      const { svc, projectsService } = fakes(over as any);
      await expect(svc.createPreviewBranch('parent', 'u1', { name: 'pr-42' })).rejects.toThrow(re);
      expect(projectsService.create).not.toHaveBeenCalled();
    }
  });

  it('lets the plan entitlement refuse branching', async () => {
    const { svc, entitlement, projectsService } = fakes();
    entitlement.assertCan.mockRejectedValue(new ForbiddenException('Not included in your plan'));
    await expect(svc.createPreviewBranch('parent', 'u1', { name: 'pr-42' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(entitlement.assertCan).toHaveBeenCalledWith('parent', 'project_branches');
    expect(projectsService.create).not.toHaveBeenCalled();
  });

  it('caps live branches per parent and ignores trashed or deactivated ones in the count', async () => {
    const { svc, prisma, projectsService } = fakes({ live: 3 });
    await expect(svc.createPreviewBranch('parent', 'u1', { name: 'pr-42' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.project.count.mock.calls[0][0].where).toEqual({
      parentProjectId: 'parent',
      status: { notIn: ['DELETED', 'DEACTIVATED'] },
    });
    expect(projectsService.create).not.toHaveBeenCalled();

    process.env.BRANCH_LIMIT_PER_PROJECT = '5';
    const more = fakes({ live: 3 });
    jest.spyOn(more.svc, 'populateBranch').mockResolvedValue(undefined);
    await expect(more.svc.createPreviewBranch('parent', 'u1', { name: 'pr-42' })).resolves.toBeDefined();
  });

  it('refuses a name that exists, including one still in the trash', async () => {
    const { svc } = fakes({ taken: { id: 'x', status: 'DELETED' } });
    await expect(svc.createPreviewBranch('parent', 'u1', { name: 'pr-42' })).rejects.toThrow(/trash/);
    const live = fakes({ taken: { id: 'x', status: 'ACTIVE' } });
    await expect(live.svc.createPreviewBranch('parent', 'u1', { name: 'pr-42' })).rejects.toThrow(/already exists/);
  });

  it('limits full-data branches by database size, measured on the parent', async () => {
    process.env.BRANCH_MAX_DB_MB = '10';
    const { svc, projectsService } = fakes();
    await expect(svc.createPreviewBranch('parent', 'u1', { name: 'pr-42', dataMode: 'full' })).rejects.toThrow(/schema-only/);
    expect(clientCtor).toHaveBeenCalledWith(expect.objectContaining({ database: 'db_parent', user: 'u_parent' }));
    expect(projectsService.create).not.toHaveBeenCalled();

    // Schema-only never looks at the size.
    const schema = fakes();
    jest.spyOn(schema.svc, 'populateBranch').mockResolvedValue(undefined);
    await schema.svc.createPreviewBranch('parent', 'u1', { name: 'pr-42' });
    expect(clientCtor).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectBranchService.createPreviewBranch — happy path', () => {
  it('creates the child through ProjectsService as a BRANCH, logs on the parent and starts population', async () => {
    const { svc, projectsService, activity } = fakes();
    const populate = jest.spyOn(svc, 'populateBranch').mockResolvedValue(undefined);

    const out = await svc.createPreviewBranch('parent', 'u1', { name: 'pr-42', dataMode: 'full' });

    expect(projectsService.findOne).toHaveBeenCalledWith('parent', 'u1');
    expect(projectsService.create).toHaveBeenCalledWith(
      { name: 'Shop [pr-42]', description: 'Preview branch "pr-42" of Shop', teamId: 't1' },
      'u1',
      'BRANCH',
      { branch: { parentProjectId: 'parent', branchName: 'pr-42', dataMode: 'full' } },
    );
    expect(out.project).toEqual({
      id: 'child',
      name: 'Shop [pr-42]',
      slug: 'shop-pr-42',
      status: 'ACTIVE',
      teamId: 't1',
      createdAt: branchRow.createdAt,
    });
    expect(out.previewBranch).toMatchObject({ parentProjectId: 'parent', parentName: 'Shop', branchName: 'pr-42', syncStatus: 'pending' });
    expect((out as any).project.dbPassword).toBeUndefined();
    expect(activity.append).toHaveBeenCalledWith('parent', expect.objectContaining({ kind: 'project.branch_created' }));
    expect(populate).toHaveBeenCalledWith(expect.objectContaining({ id: 'parent' }), branchRow, 'full', 'u1');
  });
});

describe('ProjectBranchService.populateBranch', () => {
  it('dumps the parent schema-only and restores it into the branch, then re-applies the RLS bootstrap', async () => {
    const { svc, prisma, projectsService, realtime, activity } = fakes();
    await svc.populateBranch(parentRow, branchRow, 'schema', 'u1');

    const dump = argsOf('pg_dump');
    expect(dump).toEqual(expect.arrayContaining(['--format=custom', '--no-owner', '--no-acl', '--schema-only']));
    expect(dump[dump.indexOf('--dbname') + 1]).toBe('db_parent');
    expect(dump[dump.indexOf('--username') + 1]).toBe('u_parent');

    const restore = argsOf('pg_restore');
    expect(restore).toEqual(expect.arrayContaining(['--no-owner', '--no-acl', '--clean', '--if-exists']));
    expect(restore[restore.indexOf('--dbname') + 1]).toBe('db_child');
    expect(restore[restore.indexOf('--username') + 1]).toBe('u_child');

    const dumpEnv = execFileMock.mock.calls.find((c) => c[0] === 'pg_dump')![2].env;
    const restoreEnv = execFileMock.mock.calls.find((c) => c[0] === 'pg_restore')![2].env;
    expect(dumpEnv.PGPASSWORD).toBe('pw_parent');
    expect(restoreEnv.PGPASSWORD).toBe('pw_child');

    expect(projectsService.ensureRlsBootstrap).toHaveBeenCalledWith('child');
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'child' },
      data: { branchSyncStatus: 'ready', branchSyncError: null },
    });
    expect(activity.append).toHaveBeenCalledWith('child', expect.objectContaining({ title: expect.stringMatching(/populated/) }));
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'project', action: 'updated', entityId: 'child', userIds: ['u1', 'u2'] }));
  });

  it('copies data too in full mode', async () => {
    const { svc } = fakes();
    await svc.populateBranch(parentRow, branchRow, 'full', 'u1');
    expect(argsOf('pg_dump')).not.toContain('--schema-only');
  });

  it('treats pg_restore exit 1 with ignored errors as ready-with-a-note', async () => {
    execOk({ cmd: 'pg_restore', code: 1, stderr: 'pg_restore: warning: errors ignored on restore: 2\n' });
    const { svc, prisma } = fakes();
    await svc.populateBranch(parentRow, branchRow, 'schema', 'u1');
    const data = prisma.project.update.mock.calls[0][0].data;
    expect(data.branchSyncStatus).toBe('ready');
    expect(data.branchSyncError).toMatch(/ignored 2 error/);
  });

  it('marks the branch failed when pg_dump or pg_restore really fail', async () => {
    execOk({ cmd: 'pg_dump', code: 1, stderr: 'pg_dump: error: connection refused' });
    const a = fakes();
    await a.svc.populateBranch(parentRow, branchRow, 'schema', 'u1');
    expect(a.prisma.project.update.mock.calls[0][0].data).toMatchObject({
      branchSyncStatus: 'failed',
      branchSyncError: expect.stringMatching(/pg_dump failed/),
    });
    expect(a.projectsService.ensureRlsBootstrap).not.toHaveBeenCalled();

    execOk({ cmd: 'pg_restore', code: 2, stderr: 'pg_restore: error: could not connect' });
    const b = fakes();
    await b.svc.populateBranch(parentRow, branchRow, 'schema', 'u1');
    expect(b.prisma.project.update.mock.calls[0][0].data).toMatchObject({
      branchSyncStatus: 'failed',
      branchSyncError: expect.stringMatching(/pg_restore failed/),
    });
  });
});

describe('ProjectBranchService — list, delete, stale sweep', () => {
  it('lists live branches of the parent only', async () => {
    const { svc, prisma } = fakes();
    prisma.project.findMany.mockResolvedValue([{ ...branchRow, branchSyncStatus: 'ready' }]);
    const out = await svc.listPreviewBranches('parent', 'u1');
    expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({ parentProjectId: 'parent', status: { not: 'DELETED' } });
    expect(out).toEqual([
      expect.objectContaining({ id: 'child', branchName: 'pr-42', dataMode: 'schema', syncStatus: 'ready', createdAt: '2026-10-20T10:00:00.000Z' }),
    ]);
  });

  it('deletes through the ordinary project trash and frees the branch name', async () => {
    const { svc, prisma, projectsService, activity } = fakes({ taken: { id: 'child', name: 'Shop [pr-42]', branchName: 'pr-42' } });
    const out = await svc.deletePreviewBranch('parent', 'child', 'u1');
    expect(projectsService.remove).toHaveBeenCalledWith('child', 'u1', {
      reasonCode: 'preview_branch_deleted',
      reasonLabel: 'Preview branch deleted',
    });
    expect(prisma.project.update.mock.calls[0][0].data.branchName).toMatch(/^pr-42_del\d+$/);
    expect(activity.append).toHaveBeenCalledWith('parent', expect.objectContaining({ kind: 'project.branch_deleted' }));
    expect(out.message).toMatch(/trash/);
  });

  it('refuses to delete a project that is not a branch of this parent', async () => {
    const { svc, projectsService } = fakes({ taken: null });
    await expect(svc.deletePreviewBranch('parent', 'other', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(projectsService.remove).not.toHaveBeenCalled();
  });

  it('fails branches left pending by a restart', async () => {
    const { svc, prisma } = fakes();
    prisma.project.updateMany.mockResolvedValue({ count: 2 });
    expect(await svc.failStaleBranchSyncs()).toBe(2);
    const args = prisma.project.updateMany.mock.calls[0][0];
    expect(args.where.branchSyncStatus).toBe('pending');
    expect(args.where.createdAt.lt).toBeInstanceOf(Date);
    expect(args.data).toMatchObject({ branchSyncStatus: 'failed' });
  });
});
