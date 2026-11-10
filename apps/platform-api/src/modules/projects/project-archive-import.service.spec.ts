import { BadRequestException } from '@nestjs/common';
import AdmZip = require('adm-zip');
import { ProjectArchiveImportService } from './project-archive-import.service';

describe('ProjectArchiveImportService guards', () => {
  const projects = {
    create: jest.fn(),
    getProjectForSupabaseImport: jest.fn(async () => ({ id: 'p1', name: 'Live App' })),
  };
  const svc = new ProjectArchiveImportService(projects as any, {} as any, {} as any, { append: jest.fn() } as any);
  const emptyZip = new AdmZip().toBuffer();
  const file = (buffer: Buffer) => ({ buffer }) as Express.Multer.File;

  beforeEach(() => jest.clearAllMocks());

  it('rejects a ZIP with no export files before creating a project', async () => {
    await expect(
      svc.importArchive(file(emptyZip), 'u1', { teamId: 't1', nameMode: 'new', newProjectName: 'x' }),
    ).rejects.toThrow(/not a basefyio project export/);
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('rejects a non-ZIP upload with 400', async () => {
    await expect(
      svc.importArchive(file(Buffer.from('nope')), 'u1', { teamId: 't1', nameMode: 'new', newProjectName: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([undefined, '', 'live app', 'Other'])(
    'refuses to override without the exact project name (%p)',
    async (confirmProjectName) => {
      await expect(
        svc.importArchive(file(emptyZip), 'u1', { existingProjectId: 'p1', confirmProjectName }),
      ).rejects.toThrow(/exact project name/);
    },
  );

  it('passes the confirmation, then still validates the archive', async () => {
    await expect(
      svc.importArchive(file(emptyZip), 'u1', { existingProjectId: 'p1', confirmProjectName: ' Live App ' }),
    ).rejects.toThrow(/not a basefyio project export/);
  });
});
