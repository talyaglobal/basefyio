jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('./project-archive-import.service', () => ({ ProjectArchiveImportService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Readable } from 'stream';
import { ProjectExportService } from './project-export.service';

/** The archive actions of the Backup page: list fields, delete, download, back up now. */
describe('ProjectExportService — backup archives', () => {
  let storage: Record<string, jest.Mock>;
  let queue: Record<string, jest.Mock>;
  let activity: { append: jest.Mock };
  let service: ProjectExportService;

  const obj = (name: string, minutesAgo = 5) => ({
    name,
    size: 1024,
    lastModified: new Date(Date.now() - minutesAgo * 60_000),
  });

  beforeEach(() => {
    storage = {
      ensurePlatformBucket: jest.fn().mockResolvedValue(undefined),
      listPlatformObjects: jest.fn().mockResolvedValue([]),
      getPlatformObject: jest.fn().mockResolvedValue({ stream: Readable.from(['zip']), stat: { size: 3 } }),
      removePlatformObject: jest.fn().mockResolvedValue(undefined),
    };
    queue = {
      getJobs: jest.fn().mockResolvedValue([]),
      isPaused: jest.fn().mockResolvedValue(false),
      resume: jest.fn(),
      add: jest.fn().mockResolvedValue({ id: '77' }),
    };
    activity = { append: jest.fn().mockResolvedValue(undefined) };
    const projects = { findOne: jest.fn().mockResolvedValue({ id: 'p1' }) };
    service = new ProjectExportService(
      {} as any,
      storage as any,
      projects as any,
      {} as any,
      queue as any,
      activity as any,
    );
  });

  it('labels each archive and says when it expires and whether it can be deleted', async () => {
    storage.listPlatformObjects.mockImplementation(async (bucket: string) =>
      bucket === 'bf-platform-exports'
        ? [obj('p1/1-project-export-shop-x.zip')]
        : [obj('p1/2-auto-backup-shop-x.zip'), obj('p1/3-backup-shop-x.zip')],
    );
    const list = await service.listCloudBackups('p1', 'u1');
    const byTrigger = Object.fromEntries(list.map((b: any) => [b.trigger, b]));
    expect(byTrigger.export).toMatchObject({ kind: 'manual', deletable: true, retentionDays: 1 });
    expect(byTrigger.scheduled).toMatchObject({ kind: 'auto', deletable: false, retentionDays: 7 });
    expect(byTrigger['on-demand']).toMatchObject({ kind: 'auto', deletable: true });
    expect(new Date(byTrigger.scheduled.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('deletes an export but never a nightly backup', async () => {
    await expect(service.deleteCloudBackup('p1', 'u1', 'p1/1-project-export-shop.zip', 'manual')).resolves.toEqual({
      deleted: 'p1/1-project-export-shop.zip',
    });
    expect(storage.removePlatformObject).toHaveBeenCalledWith('bf-platform-exports', 'p1/1-project-export-shop.zip');

    await expect(
      service.deleteCloudBackup('p1', 'u1', 'p1/2-auto-backup-shop.zip', 'auto'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.removePlatformObject).toHaveBeenCalledTimes(1);
  });

  it('refuses archives of another project', async () => {
    await expect(service.deleteCloudBackup('p1', 'u1', 'p2/1-x.zip', 'manual')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.downloadCloudBackup('p1', 'u1', 'p1/../p2/x.zip', 'manual')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('streams a plain archive for download', async () => {
    const file = await service.downloadCloudBackup('p1', 'u1', 'p1/1-project-export-shop.zip', 'manual');
    expect(file.filename).toBe('1-project-export-shop.zip');
    expect(file.size).toBe(3);
  });

  it('starts an on-demand backup stored like the nightly ones', async () => {
    await expect(service.startOnDemandBackup('p1', 'u1')).resolves.toEqual({ jobId: '77' });
    expect(queue.add).toHaveBeenCalledWith(
      'project-export',
      expect.objectContaining({ projectId: 'p1', autoBackup: true, onDemand: true, includeStorage: false }),
      expect.any(Object),
    );
  });

  it('refuses a second backup while one runs, and caps how many a project keeps', async () => {
    queue.getJobs.mockResolvedValueOnce([{ data: { projectId: 'p1', autoBackup: true } }]);
    await expect(service.startOnDemandBackup('p1', 'u1')).rejects.toBeInstanceOf(ConflictException);

    storage.listPlatformObjects.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => obj(`p1/${i}-backup-shop-${i}.zip`)),
    );
    await expect(service.startOnDemandBackup('p1', 'u1')).rejects.toThrow(/already has 5 on-demand backups/);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
