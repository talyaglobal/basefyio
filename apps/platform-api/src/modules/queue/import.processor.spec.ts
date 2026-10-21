// The import service pulls in an ESM-only Keycloak client; only its identity
// matters for constructing the processor here.
jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));

import { ImportProcessor } from './import.processor';
import type { ImportProgress } from '../projects/supabase-import.service';

type UpdateArgs = { where: { id: string }; data: { supabaseImportLog: any } };

function processorWith(storedLog: unknown) {
  const prisma = {
    project: {
      findUnique: jest.fn(async (_args: unknown) => ({ supabaseImportLog: storedLog })),
      update: jest.fn(async (_args: UpdateArgs) => undefined),
    },
  };
  const processor: any = Object.create(ImportProcessor.prototype);
  processor.prisma = prisma;
  processor.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { processor, prisma };
}

const syncProgress: ImportProgress = {
  database: { tables: 1, rows: 5, failedTables: [] },
  auth: { users: 0, skipped: 0 },
  storage: { buckets: 0, objects: 0 },
  warnings: [],
  tables: [
    {
      table: 'items',
      sourceRows: 15,
      importedRows: 5,
      destinationRows: 15,
      rowCountMismatch: false,
      sourceCountMethod: 'direct',
      primaryKey: 'present',
    },
  ],
};

describe('ImportProcessor.persistSyncLog', () => {
  it('stores the sync under lastSync and leaves the full-import snapshot as it was', async () => {
    const snapshot = {
      database: { tables: 12, rows: 90000, failedTables: [] },
      auth: { users: 3, skipped: 0 },
      storage: { buckets: 1, objects: 40 },
      warnings: ['old warning'],
      completedAt: '2026-10-01T00:00:00.000Z',
    };
    const { processor, prisma } = processorWith(snapshot);

    await processor.persistSyncLog('p1', syncProgress);

    expect(prisma.project.update).toHaveBeenCalledTimes(1);
    const written = prisma.project.update.mock.calls[0][0].data.supabaseImportLog;
    expect(written).toMatchObject(snapshot);
    expect(written.lastSync).toMatchObject({
      database: { rows: 5 },
      tables: [expect.objectContaining({ table: 'items', sourceRows: 15 })],
    });
    expect(typeof written.lastSync.completedAt).toBe('string');
  });

  it('writes lastSync alone when no import log exists yet', async () => {
    const { processor, prisma } = processorWith(null);
    await processor.persistSyncLog('p1', syncProgress);
    const written = prisma.project.update.mock.calls[0][0].data.supabaseImportLog;
    expect(Object.keys(written)).toEqual(['lastSync']);
  });

  it('never fails the job over a log that could not be written', async () => {
    const { processor, prisma } = processorWith({});
    prisma.project.update.mockRejectedValue(new Error('db down'));
    await expect(processor.persistSyncLog('p1', syncProgress)).resolves.toBeUndefined();
    expect(processor.logger.warn).toHaveBeenCalled();
  });
});
