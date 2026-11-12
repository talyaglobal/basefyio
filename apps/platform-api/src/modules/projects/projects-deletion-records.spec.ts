import {
  listProjectDeletionReasons,
  originalProjectName,
  recordProjectDeletion,
} from './project-deletion-records';

/**
 * Deletion records outlive the project. The list used to be read only from the
 * activity log, which cascades away with a permanently deleted project — so a
 * permanently deleted project never appeared among the deletion reasons.
 */
const logger = { warn: jest.fn() };

describe('project deletion records', () => {
  it('strips the internal trash suffix', () => {
    expect(originalProjectName('shop_2_deleted')).toBe('shop');
    expect(originalProjectName('shop')).toBe('shop');
  });

  it('writes a record without a link to the project row, with the owner-given name', async () => {
    const prisma = {
      team: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme' }) },
      projectDeletionRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    await recordProjectDeletion(
      prisma as any,
      logger,
      { id: 'p1', name: 'qa_e2e_nosql_deleted', teamId: 't1', parentProjectId: null },
      'permanent',
      'u1',
      { reasonCode: 'testing', reasonLabel: 'Just testing', details: null },
    );
    expect(prisma.projectDeletionRecord.create.mock.calls[0][0].data).toMatchObject({
      projectId: 'p1',
      projectName: 'qa_e2e_nosql',
      teamName: 'Acme',
      kind: 'permanent',
      isBranch: false,
      reasonCode: 'testing',
    });
  });

  it('never fails the deletion when the record cannot be written', async () => {
    const prisma = {
      team: { findUnique: jest.fn().mockResolvedValue(null) },
      projectDeletionRecord: { create: jest.fn().mockRejectedValue(new Error('db')) },
    };
    await expect(
      recordProjectDeletion(prisma as any, logger, { id: 'p1', name: 'x' }, 'purged', null, null),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('lists permanent deletions, separates skipped reasons, and drops mirrored legacy rows', async () => {
    const t = new Date('2026-10-22T06:00:00Z');
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ role: 'ROOT' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'u1', firstName: 'Faruk', lastName: '', email: 'f@x' }]),
      },
      projectDeletionRecord: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'r2', projectId: 'p1', projectName: 'qa', teamId: 't1', teamName: 'Acme', userId: 'u1', kind: 'permanent', isBranch: false, reasonCode: null, reasonLabel: null, details: null, createdAt: new Date(t.getTime() + 60_000) },
          { id: 'r1', projectId: 'p1', projectName: 'qa', teamId: 't1', teamName: 'Acme', userId: 'u1', kind: 'trashed', isBranch: false, reasonCode: 'not_specified', reasonLabel: 'Not specified', details: null, createdAt: t },
        ]),
      },
      projectActivityLog: {
        findMany: jest.fn().mockResolvedValue([
          // Mirror of r1 (same project, same moment) — must not be listed twice.
          { id: 'a1', projectId: 'p1', userId: 'u1', createdAt: new Date(t.getTime() + 50), metadata: {} },
          // A pre-records legacy trash event that picked "None of the above".
          { id: 'a0', projectId: 'p0', userId: 'u1', createdAt: new Date('2026-10-01T00:00:00Z'), metadata: { reasonCode: 'none', reasonLabel: 'None of the above', originalProjectName: 'old' } },
        ]),
      },
      project: {
        findMany: jest.fn().mockResolvedValue([{ id: 'p0', name: 'old_deleted', teamId: 't1', parentProjectId: 'parent', team: { id: 't1', name: 'Acme' } }]),
      },
    };
    const rows = await listProjectDeletionReasons(prisma as any);

    expect(rows.map((r: any) => r.id)).toEqual(['r2', 'r1', 'a0']);
    expect(rows[0]).toMatchObject({ kind: 'permanent', projectName: 'qa', actorName: 'Faruk' });
    expect(rows[1]).toMatchObject({ kind: 'trashed', reasonCode: null, reasonLabel: null });
    expect(rows[2]).toMatchObject({ kind: 'trashed', reasonLabel: 'None of the above', isBranch: true });
  });
});
