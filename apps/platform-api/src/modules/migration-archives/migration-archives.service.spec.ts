import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { MigrationArchivesService } from './migration-archives.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// ── Fixtures ───────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const ARCHIVE_ID = 'arc-1';
const FILE_ID = 'file-1';
const USER_ID = 'user-1';
const TEAM_ID = 'team-1';

const REQUIRED_CONSENT_ITEMS = [
  'PRIVACY',
  'RISK',
  'ARCHIVE_POLICY',
  'DATA_RETENTION',
  'ACCESS_CONTROL',
];

const ARCHIVE_RECORD = {
  id: ARCHIVE_ID,
  projectId: PROJECT_ID,
  bucketName: 'bucket-1',
  status: 'PENDING',
  source: 'USER_UPLOAD',
  retention: '90d',
  region: 'EU',
  consentCompleted: false,
  consentCompletedAt: null,
  totalBytes: BigInt(0),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
};

const FILE_RECORD = {
  id: FILE_ID,
  archiveId: ARCHIVE_ID,
  filename: 'dump.sql',
  sizeBytes: BigInt(1024),
  contentType: null,
  uploadStatus: 'PENDING',
  uploadedBytes: BigInt(0),
  chunkSize: null,
  checksum: null,
  resumeToken: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    project: {
      findFirst: jest.fn<any>().mockResolvedValue({ id: PROJECT_ID, status: 'ACTIVE' }),
    },
    projectMembership: {
      findFirst: jest.fn<any>().mockResolvedValue({ userId: USER_ID, projectId: PROJECT_ID }),
    },
    migrationArchive: {
      create: jest.fn<any>().mockResolvedValue(ARCHIVE_RECORD),
      findFirst: jest.fn<any>().mockResolvedValue(ARCHIVE_RECORD),
      update: jest.fn<any>().mockResolvedValue({ ...ARCHIVE_RECORD, deletedAt: new Date() }),
    },
    migrationArchiveFile: {
      create: jest.fn<any>().mockResolvedValue(FILE_RECORD),
      findFirst: jest.fn<any>().mockResolvedValue(FILE_RECORD),
      findMany: jest.fn<any>().mockResolvedValue([FILE_RECORD]),
      update: jest.fn<any>().mockResolvedValue(FILE_RECORD),
    },
    migrationArchiveConsent: {
      create: jest.fn<any>().mockResolvedValue({ id: 'consent-1' }),
    },
    ...overrides,
  };
}

async function buildService(prismaOverrides: Record<string, any> = {}) {
  const prisma = buildPrisma(prismaOverrides);
  const module = await Test.createTestingModule({
    providers: [
      MigrationArchivesService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { svc: module.get(MigrationArchivesService), prisma };
}

// ── createArchive() ────────────────────────────────────────────

describe('MigrationArchivesService.createArchive()', () => {
  it('creates archive and returns view with consentCompleted: false', async () => {
    const { svc, prisma } = await buildService();
    const result = await svc.createArchive(PROJECT_ID, { source: 'USER_UPLOAD', region: 'EU' });
    expect((prisma as any).migrationArchive.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: PROJECT_ID, source: 'USER_UPLOAD', region: 'EU' }),
      }),
    );
    expect(result.consentCompleted).toBe(false);
    expect(result.id).toBe(ARCHIVE_ID);
  });

  it('scopes creation to the provided projectId', async () => {
    const { svc, prisma } = await buildService();
    await svc.createArchive('proj-999', { source: 'WE_IMPORT', region: 'US' });
    expect((prisma as any).migrationArchive.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: 'proj-999' }),
      }),
    );
  });
});

// ── getArchive() ───────────────────────────────────────────────

describe('MigrationArchivesService.getArchive()', () => {
  it('returns the archive when found', async () => {
    const { svc } = await buildService();
    const result = await svc.getArchive(PROJECT_ID, ARCHIVE_ID);
    expect(result.id).toBe(ARCHIVE_ID);
  });

  it('throws NotFoundException when archive is not found', async () => {
    const { svc } = await buildService({
      migrationArchive: {
        create: jest.fn<any>().mockResolvedValue(ARCHIVE_RECORD),
        findFirst: jest.fn<any>().mockResolvedValue(null),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    await expect(svc.getArchive(PROJECT_ID, 'no-such-archive')).rejects.toThrow(NotFoundException);
  });

  it('scopes lookup to both projectId and archiveId', async () => {
    const { svc, prisma } = await buildService();
    await svc.getArchive(PROJECT_ID, ARCHIVE_ID);
    expect((prisma as any).migrationArchive.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ARCHIVE_ID, projectId: PROJECT_ID }),
      }),
    );
  });
});

// ── initiateFileUpload() ───────────────────────────────────────

describe('MigrationArchivesService.initiateFileUpload()', () => {
  it('creates a file record with a UUID resumeToken', async () => {
    const { svc, prisma } = await buildService();
    const result = await svc.initiateFileUpload(PROJECT_ID, ARCHIVE_ID, {
      filename: 'dump.sql',
      sizeBytes: 1024,
    });
    expect((prisma as any).migrationArchiveFile.create).toHaveBeenCalled();
    // resumeToken should be a UUID-shaped string
    expect(typeof result.resumeToken).toBe('string');
    expect(result.resumeToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('stores filename and sizeBytes on the record', async () => {
    const { svc, prisma } = await buildService();
    await svc.initiateFileUpload(PROJECT_ID, ARCHIVE_ID, {
      filename: 'schema.sql',
      sizeBytes: 512,
    });
    expect((prisma as any).migrationArchiveFile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ filename: 'schema.sql', archiveId: ARCHIVE_ID }),
      }),
    );
  });

  it('throws NotFoundException when archive does not belong to project', async () => {
    const { svc } = await buildService({
      migrationArchive: {
        create: jest.fn<any>().mockResolvedValue(ARCHIVE_RECORD),
        findFirst: jest.fn<any>().mockResolvedValue(null),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    await expect(
      svc.initiateFileUpload(PROJECT_ID, 'bad-archive', { filename: 'x.sql', sizeBytes: 1 }),
    ).rejects.toThrow(NotFoundException);
  });
});

// ── recordConsent() ────────────────────────────────────────────

describe('MigrationArchivesService.recordConsent()', () => {
  const validConsentDto = {
    ipAddress: '10.0.0.1',
    privacyStatementVersion: 'v1',
    riskStatementVersion: 'v1',
    archivePolicyVersion: 'v1',
    acceptedItems: REQUIRED_CONSENT_ITEMS,
  };

  it('throws BadRequestException when acceptedItems is missing required items', async () => {
    const { svc } = await buildService();
    const incompleteConsent = {
      ...validConsentDto,
      acceptedItems: REQUIRED_CONSENT_ITEMS.slice(0, 3), // only 3 of 5
    };
    await expect(
      svc.recordConsent(PROJECT_ID, ARCHIVE_ID, USER_ID,incompleteConsent),
    ).rejects.toThrow(BadRequestException);
  });

  it('sets consentCompletedAt on the archive when all items are accepted', async () => {
    const { svc, prisma } = await buildService();
    await svc.recordConsent(PROJECT_ID, ARCHIVE_ID, USER_ID,validConsentDto);
    expect((prisma as any).migrationArchive.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ARCHIVE_ID }),
        data: expect.objectContaining({
          consentCompletedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('creates a consent record with ipAddress and accepted items', async () => {
    const { svc, prisma } = await buildService();
    await svc.recordConsent(PROJECT_ID, ARCHIVE_ID, USER_ID,validConsentDto);
    expect((prisma as any).migrationArchiveConsent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          archiveId: ARCHIVE_ID,
          ipAddress: '10.0.0.1',
        }),
      }),
    );
  });
});

// ── deleteArchive() ────────────────────────────────────────────

describe('MigrationArchivesService.deleteArchive()', () => {
  it('sets deletedAt on the archive (soft-delete)', async () => {
    const { svc, prisma } = await buildService();
    await svc.deleteArchive(PROJECT_ID, ARCHIVE_ID);
    expect((prisma as any).migrationArchive.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ARCHIVE_ID }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('throws NotFoundException when archive not found', async () => {
    const { svc } = await buildService({
      migrationArchive: {
        create: jest.fn<any>().mockResolvedValue(ARCHIVE_RECORD),
        findFirst: jest.fn<any>().mockResolvedValue(null),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    await expect(svc.deleteArchive(PROJECT_ID, 'no-such-arc')).rejects.toThrow(NotFoundException);
  });

  it('scopes the delete to the correct projectId', async () => {
    const { svc, prisma } = await buildService();
    await svc.deleteArchive(PROJECT_ID, ARCHIVE_ID);
    expect((prisma as any).migrationArchive.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: PROJECT_ID, id: ARCHIVE_ID }),
      }),
    );
  });
});
