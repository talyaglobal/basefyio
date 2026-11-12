jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }));

import { BadRequestException } from '@nestjs/common';
import AdmZip = require('adm-zip');
import {
  ProjectArchiveImportService,
  findExportRoot,
  looksLikeZipArchive,
} from './project-archive-import.service';

function zipOf(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(files)) zip.addFile(name, Buffer.from(body));
  return zip.toBuffer();
}

describe('ProjectArchiveImportService', () => {
  const target = {
    id: 'p1',
    name: 'Shop',
    slug: 'shop',
    teamId: 't1',
    dbHost: 'db',
    dbPort: 5432,
    dbUser: 'u',
    dbPassword: 'pw',
    dbName: 'd',
    keycloakRealm: 'r',
  };
  let projects: { create: jest.Mock; getProjectForSupabaseImport: jest.Mock };
  let service: ProjectArchiveImportService;

  beforeEach(() => {
    projects = {
      create: jest.fn().mockResolvedValue({ ...target, id: 'new' }),
      getProjectForSupabaseImport: jest.fn().mockResolvedValue(target),
    };
    service = new ProjectArchiveImportService(projects as any, {} as any, {} as any);
  });

  it('recognizes ZIP signatures, including an empty archive', () => {
    expect(looksLikeZipArchive(zipOf({ 'a.txt': 'x' }))).toBe(true);
    expect(looksLikeZipArchive(new AdmZip().toBuffer())).toBe(true);
    expect(looksLikeZipArchive(Buffer.from('not a zip at all'))).toBe(false);
  });

  it('finds the export at the root or inside one top-level folder', () => {
    expect(findExportRoot(['manifest.json', 'database/dump.sql'])).toBe('');
    expect(findExportRoot(['export/', 'export/project.json', 'export/database/dump.sql'])).toBe('export/');
    expect(findExportRoot(['notes.txt', 'images/a.png'])).toBeNull();
    expect(findExportRoot([])).toBeNull();
  });

  it('answers 400 with a plain message for a file that is not a ZIP, and creates nothing', async () => {
    const err = await service
      .importArchiveBuffer(Buffer.from('random bytes, definitely not a zip'), 'u1', { teamId: 't1', nameMode: 'new', newProjectName: 'x' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/not a ZIP archive/);
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('answers 400 for a truncated ZIP instead of the library error', async () => {
    const broken = zipOf({ 'manifest.json': '{}' }).subarray(0, 30);
    const err = await service.importArchiveBuffer(broken, 'u1', { teamId: 't1' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).not.toMatch(/ADM-ZIP/);
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('refuses an empty ZIP rather than creating an empty project', async () => {
    const err = await service
      .importArchiveBuffer(new AdmZip().toBuffer(), 'u1', { teamId: 't1', nameMode: 'new', newProjectName: 'x' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/not a basefyio project export/);
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('refuses an overwrite whose typed confirmation does not match the target', async () => {
    const err = await service
      .importArchiveBuffer(zipOf({ 'manifest.json': '{}' }), 'u1', {
        existingProjectId: 'p1',
        confirmProjectName: 'Other project',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/does not match the project name "Shop"/);
  });

  it('accepts a matching confirmation and reports what the archive lacked', async () => {
    const out = await service.importArchiveBuffer(zipOf({ 'manifest.json': '{}' }), 'u1', {
      existingProjectId: 'p1',
      confirmProjectName: ' Shop ',
    });
    expect(out.project.id).toBe('p1');
    expect(out.warnings.join(' ')).toMatch(/dump\.sql not found/);
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('still accepts an overwrite without a confirmation field (CLI and API callers)', async () => {
    const out = await service.importArchiveBuffer(zipOf({ 'manifest.json': '{}' }), 'u1', {
      existingProjectId: 'p1',
    });
    expect(out.project.id).toBe('p1');
  });
});
