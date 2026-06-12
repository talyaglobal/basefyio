import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { MigrationAssessmentsService } from './migration-assessments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';

// ── Fixtures ───────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const ARCHIVE_ID = 'arc-1';
const REPORT_ID = 'report-1';
const VERSION_ID = 'ver-1';
const USER_ID = 'user-1';

const ARCHIVE_WITH_CONSENT = {
  id: ARCHIVE_ID,
  projectId: PROJECT_ID,
  consentCompletedAt: new Date('2026-01-01T00:00:00Z'),
  status: 'READY',
};

const ARCHIVE_NO_CONSENT = {
  id: ARCHIVE_ID,
  projectId: PROJECT_ID,
  consentCompletedAt: null,
  status: 'PENDING',
};

const REPORT_RECORD = {
  id: REPORT_ID,
  projectId: PROJECT_ID,
  archiveId: ARCHIVE_ID,
  latestVersion: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const VERSION_RECORD = {
  id: VERSION_ID,
  reportId: REPORT_ID,
  versionNumber: 1,
  status: 'READY',
  confidencePct: 0.85,
  complexity: 'MEDIUM',
  riskLevel: 'MEDIUM',
  tablesFound: 5,
  findings: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const SQL_FILE = {
  id: 'file-1',
  archiveId: ARCHIVE_ID,
  filename: 'dump.sql',
  sizeBytes: BigInt(4096),
  uploadStatus: 'COMPLETE',
};

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    project: {
      findUnique: jest.fn<any>().mockResolvedValue({ id: PROJECT_ID, status: 'ACTIVE' }),
    },
    teamMember: {
      findUnique: jest.fn<any>().mockResolvedValue({ userId: USER_ID, projectId: PROJECT_ID }),
    },
    migrationArchive: {
      findFirst: jest.fn<any>().mockResolvedValue(ARCHIVE_WITH_CONSENT),
    },
    migrationArchiveFile: {
      findMany: jest.fn<any>().mockResolvedValue([SQL_FILE]),
    },
    migrationAssessmentReport: {
      findFirst: jest.fn<any>().mockResolvedValue(null),
      create: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
      update: jest.fn<any>().mockResolvedValue({ ...REPORT_RECORD, latestVersion: 2 }),
    },
    migrationAssessmentVersion: {
      create: jest.fn<any>().mockResolvedValue(VERSION_RECORD),
      update: jest.fn<any>().mockResolvedValue(VERSION_RECORD),
      findMany: jest.fn<any>().mockResolvedValue([VERSION_RECORD]),
    },
    migrationAssessmentFinding: {
      create: jest.fn<any>().mockResolvedValue({ id: 'finding-1' }),
      createMany: jest.fn<any>().mockResolvedValue({ count: 1 }),
    },
    ...overrides,
  };
}

async function buildService(prismaOverrides: Record<string, any> = {}) {
  const prisma = buildPrisma(prismaOverrides);
  const module = await Test.createTestingModule({
    providers: [
      MigrationAssessmentsService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { svc: module.get(MigrationAssessmentsService), prisma };
}

// ── createOrRunAssessment() ────────────────────────────────────

describe('MigrationAssessmentsService.createOrRunAssessment()', () => {
  it('throws BadRequestException when consentCompletedAt is null', async () => {
    const { svc } = await buildService({
      migrationArchive: {
        findFirst: jest.fn<any>().mockResolvedValue(ARCHIVE_NO_CONSENT),
      },
    });
    await expect(
      svc.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, USER_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates a new report when none exists', async () => {
    const { svc, prisma } = await buildService({
      migrationAssessmentReport: {
        findFirst: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        update: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
      },
    });
    await svc.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, USER_ID);
    expect((prisma as any).migrationAssessmentReport.create).toHaveBeenCalled();
  });

  it('increments latestVersion on an existing report', async () => {
    const existingReport = { ...REPORT_RECORD, latestVersion: 1 };
    const { svc, prisma } = await buildService({
      migrationAssessmentReport: {
        findFirst: jest.fn<any>().mockResolvedValue(existingReport),
        create: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        update: jest.fn<any>().mockResolvedValue({ ...existingReport, latestVersion: 2 }),
      },
    });
    await svc.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, USER_ID);
    expect((prisma as any).migrationAssessmentReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: REPORT_ID }),
        data: expect.objectContaining({ latestVersion: 2 }),
      }),
    );
  });

  it("returns a version with status 'READY' on success", async () => {
    const { svc } = await buildService();
    const result = await svc.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, USER_ID);
    expect(result.status).toBe('READY');
  });

  it('sets confidencePct = 0.85 when archive contains SQL files', async () => {
    const { svc } = await buildService({
      migrationArchiveFile: {
        findMany: jest.fn<any>().mockResolvedValue([
          { ...SQL_FILE, filename: 'schema.sql' },
          { ...SQL_FILE, id: 'file-2', filename: 'data.sql' },
        ]),
      },
      migrationAssessmentVersion: {
        create: jest.fn<any>().mockResolvedValue({ ...VERSION_RECORD, confidencePct: 0.85 }),
        update: jest.fn<any>().mockResolvedValue({ ...VERSION_RECORD, confidencePct: 0.85 }),
        findMany: jest.fn<any>().mockResolvedValue([]),
      },
    });
    const result = await svc.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, USER_ID);
    expect(result.confidencePct).toBe(0.85);
  });

  it("sets complexity = 'HIGH' when tablesFound > 20 (many CSV files)", async () => {
    const csvFiles = Array.from({ length: 25 }, (_, i) => ({
      ...SQL_FILE,
      id: `file-${i}`,
      filename: `table_${i}.csv`,
    }));
    const { svc } = await buildService({
      migrationArchiveFile: {
        findMany: jest.fn<any>().mockResolvedValue(csvFiles),
      },
      migrationAssessmentVersion: {
        create: jest.fn<any>().mockResolvedValue({ ...VERSION_RECORD, complexity: 'HIGH', tablesFound: 25 }),
        update: jest.fn<any>().mockResolvedValue({ ...VERSION_RECORD, complexity: 'HIGH', tablesFound: 25 }),
        findMany: jest.fn<any>().mockResolvedValue([]),
      },
    });
    const result = await svc.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, USER_ID);
    expect(result.complexity).toBe('HIGH');
  });

  it("sets riskLevel = 'LOW' when there is a single small file", async () => {
    const smallFile = { ...SQL_FILE, sizeBytes: BigInt(512), filename: 'tiny.sql' };
    const { svc } = await buildService({
      migrationArchiveFile: {
        findMany: jest.fn<any>().mockResolvedValue([smallFile]),
      },
      migrationAssessmentVersion: {
        create: jest.fn<any>().mockResolvedValue({ ...VERSION_RECORD, riskLevel: 'LOW', tablesFound: 1 }),
        update: jest.fn<any>().mockResolvedValue({ ...VERSION_RECORD, riskLevel: 'LOW', tablesFound: 1 }),
        findMany: jest.fn<any>().mockResolvedValue([]),
      },
    });
    const result = await svc.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, USER_ID);
    expect(result.riskLevel).toBe('LOW');
  });
});

// ── getReport() ────────────────────────────────────────────────

describe('MigrationAssessmentsService.getReport()', () => {
  it('throws NotFoundException when report is not found', async () => {
    const { svc } = await buildService({
      migrationAssessmentReport: {
        findFirst: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        update: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
      },
    });
    await expect(svc.getReport(PROJECT_ID, 'no-such-report')).rejects.toThrow(NotFoundException);
  });

  it('returns the report view when found', async () => {
    const { svc } = await buildService({
      migrationAssessmentReport: {
        findFirst: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        create: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        update: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
      },
    });
    const result = await svc.getReport(PROJECT_ID, REPORT_ID);
    expect(result.id).toBe(REPORT_ID);
  });
});

// ── listReports() ──────────────────────────────────────────────

describe('MigrationAssessmentsService.listReports()', () => {
  it('calls findMany with a projectId filter and returns an array', async () => {
    const reports = [REPORT_RECORD, { ...REPORT_RECORD, id: 'report-2' }];
    const { svc, prisma } = await buildService({
      migrationAssessmentReport: {
        findFirst: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        update: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        findMany: jest.fn<any>().mockResolvedValue(reports),
      },
    });
    const result = await svc.listReports(PROJECT_ID);
    expect((prisma as any).migrationAssessmentReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: PROJECT_ID }),
      }),
    );
    expect(result).toHaveLength(2);
  });
});

// ── getVersions() ──────────────────────────────────────────────

describe('MigrationAssessmentsService.getVersions()', () => {
  it('includes findings in the returned versions', async () => {
    const versionWithFindings = {
      ...VERSION_RECORD,
      findings: [{ id: 'finding-1', title: 'Missing index', severity: 'MEDIUM' }],
    };
    const { svc } = await buildService({
      migrationAssessmentReport: {
        findFirst: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        create: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        update: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
      },
      migrationAssessmentVersion: {
        create: jest.fn<any>().mockResolvedValue(versionWithFindings),
        update: jest.fn<any>().mockResolvedValue(versionWithFindings),
        findMany: jest.fn<any>().mockResolvedValue([versionWithFindings]),
      },
    });
    const result = await svc.getVersions(PROJECT_ID, REPORT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].findings).toHaveLength(1);
    expect(result[0].findings[0].title).toBe('Missing index');
  });
});

// ── exportPdf() ────────────────────────────────────────────────

describe('MigrationAssessmentsService.exportPdf()', () => {
  it("returns { exportJobId, status: 'QUEUED' }", async () => {
    const { svc } = await buildService({
      migrationAssessmentReport: {
        findFirst: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        create: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
        update: jest.fn<any>().mockResolvedValue(REPORT_RECORD),
      },
    });
    const result = await svc.exportPdf(PROJECT_ID, REPORT_ID);
    expect(result.status).toBe('QUEUED');
    expect(typeof result.exportJobId).toBe('string');
    expect(result.exportJobId.length).toBeGreaterThan(0);
  });
});

// ── assertProjectMember() ──────────────────────────────────────

describe('MigrationAssessmentsService.assertProjectMember()', () => {
  it('throws NotFoundException when the project does not exist', async () => {
    const { svc } = await buildService({
      project: { findUnique: jest.fn<any>().mockResolvedValue(null) },
    });
    await expect(svc.assertProjectMember(PROJECT_ID, USER_ID)).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the user is not a team member', async () => {
    const { svc } = await buildService({
      teamMember: { findUnique: jest.fn<any>().mockResolvedValue(null) },
    });
    await expect(svc.assertProjectMember(PROJECT_ID, USER_ID)).rejects.toThrow(ForbiddenException);
  });
});
