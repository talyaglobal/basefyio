jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('./project-archive-import.service', () => ({ ProjectArchiveImportService: class {} }));
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }));
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { ProjectExportService } from './project-export.service';

/** #34: cloud backups can be downloaded, and manual exports deleted by members who may delete projects. */
function build(role: string, objects: string[] = ['p1/export-1.zip']) {
  const prisma = {
    teamMember: { findUnique: jest.fn(async () => (role ? { role } : null)) },
    teamRolePermission: { findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null) },
  };
  const storage = {
    listPlatformObjects: jest.fn(async () => objects.map((name) => ({ name, size: 1, lastModified: new Date() }))),
    removePlatformObject: jest.fn(async () => undefined),
    getPlatformObject: jest.fn(async () => ({ stream: Readable.from([Buffer.from('zip')]), stat: { size: 3 } })),
  };
  const projects = { findOne: jest.fn(async () => ({ id: 'p1', teamId: 't1' })) };
  const activity = { append: jest.fn(async () => undefined) };
  const svc = new ProjectExportService(prisma as any, storage as any, projects as any, {} as any, {} as any, activity as any);
  return { svc, storage, activity };
}

describe('ProjectExportService cloud backups', () => {
  it('an owner deletes a manual export, and it is logged', async () => {
    const { svc, storage, activity } = build('OWNER');
    await expect(svc.deleteCloudBackup('p1', 'u1', 'p1/export-1.zip')).resolves.toEqual({ deleted: true });
    expect(storage.removePlatformObject).toHaveBeenCalledWith(expect.any(String), 'p1/export-1.zip');
    expect(activity.append).toHaveBeenCalled();
  });

  it('a member without the delete right cannot delete', async () => {
    const { svc, storage } = build('MEMBER');
    await expect(svc.deleteCloudBackup('p1', 'u1', 'p1/export-1.zip')).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.removePlatformObject).not.toHaveBeenCalled();
  });

  it('refuses a key of another project and a missing object', async () => {
    const { svc } = build('OWNER', []);
    await expect(svc.deleteCloudBackup('p1', 'u1', 'p2/export.zip')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.deleteCloudBackup('p1', 'u1', 'p1/../p2/x.zip')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.deleteCloudBackup('p1', 'u1', 'p1/gone.zip')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('downloads a plain backup with its file name', async () => {
    const { svc } = build('MEMBER');
    const f = await svc.getCloudBackupFile('p1', 'u1', 'p1/nightly/2026-11-23.zip', 'auto');
    expect(f.filename).toBe('2026-11-23.zip');
    expect(f.size).toBe(3);
  });
});
