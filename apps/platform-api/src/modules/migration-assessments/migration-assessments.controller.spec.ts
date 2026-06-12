import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { MigrationAssessmentsController } from './migration-assessments.controller';
import { MigrationAssessmentsService } from './migration-assessments.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { EntitlementService } from '../entitlement/entitlement.service';

// ── Fixtures ───────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const ARCHIVE_ID = 'arc-1';
const REPORT_ID = 'report-1';
const VERSION_ID = 'ver-1';
const USER_ID = 'user-1';

const MOCK_VERSION_VIEW = {
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

const MOCK_REPORT_VIEW = {
  id: REPORT_ID,
  projectId: PROJECT_ID,
  archiveId: ARCHIVE_ID,
  latestVersion: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const MOCK_EXPORT_RESULT = {
  exportJobId: 'job-abc-123',
  status: 'QUEUED',
  message: 'PDF export queued',
};

function buildMockService() {
  return {
    assertProjectMember: jest.fn<any>().mockResolvedValue(undefined),
    createOrRunAssessment: jest.fn<any>().mockResolvedValue(MOCK_VERSION_VIEW),
    listReports: jest.fn<any>().mockResolvedValue([MOCK_REPORT_VIEW]),
    getReport: jest.fn<any>().mockResolvedValue(MOCK_REPORT_VIEW),
    getVersions: jest.fn<any>().mockResolvedValue([MOCK_VERSION_VIEW]),
    exportPdf: jest.fn<any>().mockResolvedValue(MOCK_EXPORT_RESULT),
  };
}

async function buildController(serviceOverrides: Record<string, any> = {}) {
  const mockService = { ...buildMockService(), ...serviceOverrides };
  const module: TestingModule = await Test.createTestingModule({
    controllers: [MigrationAssessmentsController],
    providers: [
      { provide: MigrationAssessmentsService, useValue: mockService },
      { provide: EntitlementService, useValue: { assertCan: jest.fn<any>().mockResolvedValue(undefined) } },
    ],
  })
    .overrideGuard(JwtOrApiKeyGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return {
    ctrl: module.get(MigrationAssessmentsController),
    svc: mockService,
  };
}

// ── POST /archives/:archiveId/assessments ──────────────────────

describe('MigrationAssessmentsController POST /archives/:archiveId/assessments', () => {
  it('calls createOrRunAssessment and returns the version view', async () => {
    const { ctrl, svc } = await buildController();
    const result = await ctrl.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, { sub: USER_ID } as any);
    expect(svc.createOrRunAssessment).toHaveBeenCalledWith(PROJECT_ID, ARCHIVE_ID, USER_ID);
    expect(result).toEqual(MOCK_VERSION_VIEW);
  });

  it('propagates ForbiddenException when assertProjectMember throws', async () => {
    const { ctrl } = await buildController({
      assertProjectMember: jest.fn<any>().mockRejectedValue(new ForbiddenException()),
    });
    await expect(ctrl.createOrRunAssessment(PROJECT_ID, ARCHIVE_ID, { sub: USER_ID } as any)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// ── GET /assessments ───────────────────────────────────────────

describe('MigrationAssessmentsController GET /assessments', () => {
  it('calls listReports with projectId and returns the array', async () => {
    const { ctrl, svc } = await buildController();
    const result = await ctrl.listReports(PROJECT_ID, { sub: USER_ID } as any);
    expect(svc.listReports).toHaveBeenCalledWith(PROJECT_ID);
    expect(result).toEqual([MOCK_REPORT_VIEW]);
  });
});

// ── GET /assessments/:id ───────────────────────────────────────

describe('MigrationAssessmentsController GET /assessments/:id', () => {
  it('calls getReport with projectId and reportId', async () => {
    const { ctrl, svc } = await buildController();
    const result = await ctrl.getReport(PROJECT_ID, REPORT_ID, { sub: USER_ID } as any);
    expect(svc.getReport).toHaveBeenCalledWith(PROJECT_ID, REPORT_ID);
    expect(result).toEqual(MOCK_REPORT_VIEW);
  });

  it('propagates NotFoundException when report is not found', async () => {
    const { ctrl } = await buildController({
      getReport: jest.fn<any>().mockRejectedValue(new NotFoundException()),
    });
    await expect(ctrl.getReport(PROJECT_ID, 'no-such-report', { sub: USER_ID } as any)).rejects.toThrow(NotFoundException);
  });
});

// ── GET /assessments/:id/versions ─────────────────────────────

describe('MigrationAssessmentsController GET /assessments/:id/versions', () => {
  it('calls getVersions with projectId and reportId', async () => {
    const { ctrl, svc } = await buildController();
    const result = await ctrl.getVersions(PROJECT_ID, REPORT_ID, { sub: USER_ID } as any);
    expect(svc.getVersions).toHaveBeenCalledWith(PROJECT_ID, REPORT_ID);
    expect(result).toEqual([MOCK_VERSION_VIEW]);
  });
});

// ── POST /assessments/:id/export-pdf ──────────────────────────

describe('MigrationAssessmentsController POST /assessments/:id/export-pdf', () => {
  it("calls exportPdf and returns { exportJobId, status: 'QUEUED' }", async () => {
    const { ctrl, svc } = await buildController();
    const result = await ctrl.exportPdf(PROJECT_ID, REPORT_ID, {}, { sub: USER_ID } as any);
    expect(svc.exportPdf).toHaveBeenCalledWith(PROJECT_ID, REPORT_ID, undefined);
    expect(result.status).toBe('QUEUED');
    expect(typeof result.exportJobId).toBe('string');
  });

  it('forwards versionId from the request body to exportPdf', async () => {
    const { ctrl, svc } = await buildController();
    await ctrl.exportPdf(PROJECT_ID, REPORT_ID, { versionId: VERSION_ID }, { sub: USER_ID } as any);
    expect(svc.exportPdf).toHaveBeenCalledWith(PROJECT_ID, REPORT_ID, VERSION_ID);
  });
});
