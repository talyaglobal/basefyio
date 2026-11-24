import {
  countPermanentlyDeletedProjects,
  displayProjectName,
  lastTrashReason,
  listDeletionEntries,
  normalizeDeletionReason,
  recordProjectDeletion,
} from './project-deletion-records';
import { ProjectsService } from './projects.service';

/** #190: deletion records survive permanent deletion and tell "no reason" from "None of the above". */
function prismaMock() {
  return {
    team: { findUnique: jest.fn(async () => ({ name: 'Team A' })) },
    projectDeletionRecord: {
      create: jest.fn(async () => ({ id: 'r1' })),
      findMany: jest.fn(async (): Promise<any[]> => []),
    },
    projectActivityLog: {
      findMany: jest.fn(async (): Promise<any[]> => []),
      findFirst: jest.fn(async (): Promise<any> => null),
    },
    user: { findMany: jest.fn(async () => [{ id: 'u1', firstName: 'Ada', lastName: 'L', email: 'a@b.c' }]) },
    project: { findMany: jest.fn(async (): Promise<any[]> => []), delete: jest.fn(async () => ({})) },
  };
}

describe('project deletion records (#190)', () => {
  it('strips the internal trash suffix for display', () => {
    expect(displayProjectName('shop_deleted')).toBe('shop');
    expect(displayProjectName('shop_3_deleted')).toBe('shop');
    expect(displayProjectName('shop')).toBe('shop');
  });

  it('keeps "no reason" apart from "None of the above"', () => {
    expect(normalizeDeletionReason(undefined)).toEqual({ reasonCode: null, reasonLabel: null, details: null });
    expect(normalizeDeletionReason({ reasonCode: '' }).reasonCode).toBeNull();
    expect(normalizeDeletionReason({ reasonCode: 'none', reasonLabel: 'None of the above' })).toEqual({
      reasonCode: 'none',
      reasonLabel: 'None of the above',
      details: null,
    });
  });

  it('writes a snapshot with the display name, team name and kind', async () => {
    const prisma = prismaMock();
    await recordProjectDeletion(prisma, undefined, {
      kind: 'permanent',
      project: { id: 'p1', name: 'shop_2_deleted', slug: 'shop_deleted', teamId: 't1', parentProjectId: null },
      actorUserId: 'u1',
      reason: { reasonCode: 'too_expensive', reasonLabel: 'Too expensive' },
    });
    expect(prisma.projectDeletionRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'permanent',
        projectId: 'p1',
        projectName: 'shop',
        projectSlug: 'shop',
        teamName: 'Team A',
        actorUserId: 'u1',
        reasonCode: 'too_expensive',
      }),
    });
  });

  it('never throws when the record cannot be written', async () => {
    const prisma = prismaMock();
    prisma.projectDeletionRecord.create.mockRejectedValueOnce(new Error('db down'));
    const warn = jest.fn();
    await expect(
      recordProjectDeletion(prisma, { warn }, { kind: 'trashed', project: { id: 'p1', name: 'x' } }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('lists records and older activity rows once, newest first', async () => {
    const prisma = prismaMock();
    prisma.projectDeletionRecord.findMany.mockResolvedValueOnce([
      { id: 'r2', kind: 'permanent', projectId: 'gone', projectName: 'gone', parentProjectId: null, teamId: 't1', teamName: 'Team A', actorUserId: null, reasonCode: null, reasonLabel: null, details: null, createdAt: new Date('2026-11-24T10:00:00Z') },
    ]);
    prisma.projectActivityLog.findMany.mockResolvedValueOnce([
      // Has a record already: not listed twice.
      { id: 'a2', projectId: 'gone', userId: 'u1', createdAt: new Date('2026-11-23T10:00:00Z'), metadata: { deletionRecorded: true } },
      // Older row from before records: listed as it is.
      { id: 'a1', projectId: 'old', userId: 'u1', createdAt: new Date('2026-11-01T10:00:00Z'), metadata: { originalProjectName: 'old', reasonCode: 'none', reasonLabel: 'None of the above' } },
    ]);
    const rows = await listDeletionEntries(prisma, 50);
    expect(rows.map((r) => r.id)).toEqual(['r2', 'a1']);
    expect(rows[0]).toMatchObject({ kind: 'permanent', projectStatus: null, reasonCode: null, source: 'record' });
    expect(rows[1]).toMatchObject({ kind: 'trashed', reasonCode: 'none', actorName: 'Ada L', source: 'activity' });
  });

  it('counts permanently deleted real projects, not preview branches', async () => {
    const prisma = prismaMock();
    prisma.projectDeletionRecord.findMany.mockResolvedValueOnce([{ projectId: 'a' }, { projectId: 'b' }]);
    expect(await countPermanentlyDeletedProjects(prisma)).toBe(2);
    expect((prisma.projectDeletionRecord.findMany.mock.calls as any)[0][0].where).toEqual({
      kind: 'permanent',
      parentProjectId: null,
    });
  });

  it('reads the last trash reason from the activity log', async () => {
    const prisma = prismaMock();
    prisma.projectActivityLog.findFirst.mockResolvedValueOnce({ metadata: { reasonCode: 'cancelled', reasonLabel: 'C' } });
    expect(await lastTrashReason(prisma, 'p1')).toEqual({ reasonCode: 'cancelled', reasonLabel: 'C', details: null });
  });

  it('permanent teardown keeps the reason and writes a record after the row is gone', async () => {
    const prisma = prismaMock();
    const order: string[] = [];
    prisma.projectActivityLog.findFirst.mockImplementationOnce(async () => {
      order.push('reason');
      return { metadata: { reasonCode: 'exploring', reasonLabel: 'Exploring' } };
    });
    prisma.project.delete.mockImplementationOnce(async () => {
      order.push('delete');
      return {};
    });
    prisma.projectDeletionRecord.create.mockImplementationOnce(async () => {
      order.push('record');
      return { id: 'r' };
    });
    const svc = Object.create(ProjectsService.prototype) as any;
    Object.assign(svc, {
      prisma,
      pgbouncer: { regenerateConfig: jest.fn().mockResolvedValue(undefined) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      deleteProjectRealm: jest.fn().mockResolvedValue(undefined),
      dropDatabase: jest.fn().mockResolvedValue(undefined),
      dropDatabaseUser: jest.fn().mockResolvedValue(undefined),
      dropReadonlyRoleQuietly: jest.fn().mockResolvedValue(undefined),
    });
    await svc.performPermanentTeardown(
      { id: 'p1', name: 'shop_deleted', slug: 'shop_deleted', teamId: 't1', keycloakRealm: 'r', dbName: 'd', dbUser: 'u' },
      'u1',
    );
    expect(order).toEqual(['reason', 'delete', 'record']);
    expect(prisma.projectDeletionRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'permanent', projectName: 'shop', reasonCode: 'exploring', actorUserId: 'u1' }),
    });
  });
});
