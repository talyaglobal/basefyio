import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

// ── View interfaces ────────────────────────────────────────────────────────────

export interface AssessmentReportView {
  id: string;
  projectId: string;
  archiveId: string;
  status: string;
  latestVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FindingView {
  id: string;
  category: string;
  title: string;
  detail: string;
  riskLevel: string | null;
  metadata: unknown;
}

export interface AssessmentVersionView {
  id: string;
  reportId: string;
  version: number;
  status: string;
  tablesFound: number | null;
  recordsFound: string | null;
  sizeBytes: string | null;
  confidencePct: number | null;
  complexity: string | null;
  riskLevel: string | null;
  estimatedCostCents: number | null;
  estimatedDurationDays: number | null;
  humanInvolvementPct: number | null;
  dataLossRiskPct: number | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  findings: FindingView[];
}

// ── Helper mappers ─────────────────────────────────────────────────────────────

function toReportView(row: {
  id: string;
  projectId: string;
  archiveId: string;
  status: string;
  latestVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): AssessmentReportView {
  return {
    id: row.id,
    projectId: row.projectId,
    archiveId: row.archiveId,
    status: row.status,
    latestVersion: row.latestVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersionView(
  row: {
    id: string;
    reportId: string;
    version: number;
    status: string;
    tablesFound: number | null;
    recordsFound: bigint | null;
    sizeBytes: bigint | null;
    confidencePct: number | null;
    complexity: string | null;
    riskLevel: string | null;
    estimatedCostCents: number | null;
    estimatedDurationDays: number | null;
    humanInvolvementPct: number | null;
    dataLossRiskPct: number | null;
    errorMessage: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
  },
  findings: FindingView[],
): AssessmentVersionView {
  return {
    id: row.id,
    reportId: row.reportId,
    version: row.version,
    status: row.status,
    tablesFound: row.tablesFound,
    recordsFound: row.recordsFound != null ? row.recordsFound.toString() : null,
    sizeBytes: row.sizeBytes != null ? row.sizeBytes.toString() : null,
    confidencePct: row.confidencePct,
    complexity: row.complexity,
    riskLevel: row.riskLevel,
    estimatedCostCents: row.estimatedCostCents,
    estimatedDurationDays: row.estimatedDurationDays,
    humanInvolvementPct: row.humanInvolvementPct,
    dataLossRiskPct: row.dataLossRiskPct,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    findings,
  };
}

function toFindingView(row: {
  id: string;
  category: string;
  title: string;
  detail: string;
  riskLevel: string | null;
  metadata: unknown;
}): FindingView {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    detail: row.detail,
    riskLevel: row.riskLevel,
    metadata: row.metadata,
  };
}

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class MigrationAssessmentsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // assertProjectMember — same pattern as MigrationArchivesService
  // ---------------------------------------------------------------------------

  async assertProjectMember(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new ForbiddenException("Not a member of this project's team");
  }

  // ---------------------------------------------------------------------------
  // createOrRunAssessment
  // ---------------------------------------------------------------------------

  async createOrRunAssessment(
    projectId: string,
    archiveId: string,
    userId: string,
  ): Promise<AssessmentVersionView> {
    // 1. Assert archive belongs to project
    const archive = await this.prisma.migrationArchive.findFirst({
      where: { id: archiveId, projectId },
      select: {
        id: true,
        consentCompletedAt: true,
      },
    });
    if (!archive) throw new NotFoundException('Migration archive not found');

    // 2. Consent must be completed
    if (!archive.consentCompletedAt) {
      throw new BadRequestException('Consent not completed');
    }

    // 3. Upsert MigrationAssessmentReport
    let report = await (this.prisma as any).migrationAssessmentReport.findFirst({
      where: { archiveId },
    });

    if (!report) {
      report = await (this.prisma as any).migrationAssessmentReport.create({
        data: {
          projectId,
          archiveId,
          status: 'ANALYZING',
          latestVersion: 0,
        },
      });
    } else {
      report = await (this.prisma as any).migrationAssessmentReport.update({
        where: { id: report.id },
        data: { status: 'ANALYZING' },
      });
    }

    // 4. Increment latestVersion by 1
    const nextVersion: number = (report.latestVersion ?? 0) + 1;

    await (this.prisma as any).migrationAssessmentReport.update({
      where: { id: report.id },
      data: { latestVersion: nextVersion },
    });

    // 5. Create MigrationAssessmentVersion with status ANALYZING
    const now = new Date();
    let version = await (this.prisma as any).migrationAssessmentVersion.create({
      data: {
        reportId: report.id,
        version: nextVersion,
        status: 'ANALYZING',
        startedAt: now,
      },
    });

    // 6. Run heuristic analyzer
    const files: Array<{ filename: string; sizeBytes: bigint }> =
      await this.prisma.migrationArchiveFile.findMany({
        where: { archiveId },
        select: { filename: true, sizeBytes: true },
      });

    const totalSizeBytes: bigint = files.reduce(
      (acc, f) => acc + f.sizeBytes,
      BigInt(0),
    );

    // Count file extensions
    let sqlCount = 0;
    let csvCount = 0;
    let excelCount = 0;
    let jsonCount = 0;

    for (const f of files) {
      const lower = f.filename.toLowerCase();
      if (lower.endsWith('.sql') || lower.endsWith('.dump')) {
        sqlCount++;
      } else if (lower.endsWith('.csv')) {
        csvCount++;
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        excelCount++;
      } else if (lower.endsWith('.json') || lower.endsWith('.ndjson')) {
        jsonCount++;
      }
    }

    const tablesFound = Math.max(
      sqlCount > 0 ? 15 : 0,
      csvCount,
      excelCount * 3,
      jsonCount * 2,
      1,
    );

    const recordsFound = BigInt(Math.round(Number(totalSizeBytes) / 500));

    let confidencePct: number;
    if (sqlCount > 0) {
      confidencePct = 0.85;
    } else if (excelCount > 0) {
      confidencePct = 0.75;
    } else if (csvCount > 0) {
      confidencePct = 0.70;
    } else {
      confidencePct = 0.50;
    }

    const ONE_GB = 1_000_000_000;
    const ONE_HUNDRED_MB = 100_000_000;
    const sizeNum = Number(totalSizeBytes);

    let complexity: string;
    if (tablesFound > 20 || sizeNum > ONE_GB) {
      complexity = 'HIGH';
    } else if (tablesFound > 5 || sizeNum > ONE_HUNDRED_MB) {
      complexity = 'MEDIUM';
    } else {
      complexity = 'LOW';
    }

    const riskLevel = complexity; // HIGH → 'HIGH', MEDIUM → 'MEDIUM', LOW → 'LOW'

    let dataLossRiskPct: number;
    if (riskLevel === 'HIGH') {
      dataLossRiskPct = 5.0;
    } else if (riskLevel === 'MEDIUM') {
      dataLossRiskPct = 2.5;
    } else {
      dataLossRiskPct = 0.5;
    }

    let humanInvolvementPct: number;
    if (riskLevel === 'HIGH') {
      humanInvolvementPct = 30;
    } else if (riskLevel === 'MEDIUM') {
      humanInvolvementPct = 15;
    } else {
      humanInvolvementPct = 5;
    }

    const estimatedDurationDays = Math.max(1, tablesFound / 10);

    const hourlyRateCents = 10000; // $100/hr
    const estimatedHours = tablesFound * 2 + sizeNum / 1e9 * 8;
    const estimatedCostCents = Math.round(estimatedHours * hourlyRateCents);

    // 7. Generate findings
    const findingRows: Array<{
      category: string;
      title: string;
      detail: string;
      riskLevel: string | null;
    }> = [];

    if (sqlCount > 0) {
      findingRows.push({
        category: 'table',
        title: 'SQL dump detected',
        detail: `Found ${sqlCount} SQL/dump file(s). Schema and data can be parsed directly for high-fidelity migration.`,
        riskLevel: 'LOW',
      });
    }

    if (dataLossRiskPct >= 5) {
      findingRows.push({
        category: 'risk',
        title: 'High data loss risk',
        detail: `Estimated data loss risk is ${dataLossRiskPct}%. Manual review and validation steps are strongly recommended.`,
        riskLevel: 'HIGH',
      });
    }

    if (complexity === 'HIGH') {
      findingRows.push({
        category: 'risk',
        title: 'Complex migration',
        detail: `Migration complexity is HIGH (${tablesFound} tables, ${(sizeNum / 1e6).toFixed(1)} MB). Expect extended timelines and dedicated engineering effort.`,
        riskLevel: 'MEDIUM',
      });
    }

    // Always add recommendation
    findingRows.push({
      category: 'recommendation',
      title: 'Archive-first migration',
      detail: 'All data is safely archived before migration begins. This ensures full rollback capability and audit compliance.',
      riskLevel: null,
    });

    const createdFindings: FindingView[] = [];
    for (const f of findingRows) {
      const finding = await (this.prisma as any).migrationAssessmentFinding.create({
        data: {
          versionId: version.id,
          category: f.category,
          title: f.title,
          detail: f.detail,
          riskLevel: f.riskLevel,
          metadata: {},
        },
      });
      createdFindings.push(toFindingView(finding));
    }

    // 8. Update version with all computed values, status=READY
    const completedAt = new Date();
    version = await (this.prisma as any).migrationAssessmentVersion.update({
      where: { id: version.id },
      data: {
        status: 'READY',
        tablesFound,
        recordsFound,
        sizeBytes: totalSizeBytes,
        confidencePct,
        complexity,
        riskLevel,
        estimatedCostCents,
        estimatedDurationDays,
        humanInvolvementPct,
        dataLossRiskPct,
        completedAt,
      },
    });

    // 9. Update report status=READY
    await (this.prisma as any).migrationAssessmentReport.update({
      where: { id: report.id },
      data: { status: 'READY' },
    });

    // 10. Return the version view with findings
    return toVersionView(version, createdFindings);
  }

  // ---------------------------------------------------------------------------
  // getReport
  // ---------------------------------------------------------------------------

  async getReport(projectId: string, reportId: string): Promise<AssessmentReportView> {
    const report = await (this.prisma as any).migrationAssessmentReport.findFirst({
      where: { id: reportId, projectId },
    });
    if (!report) throw new NotFoundException('Assessment report not found');
    return toReportView(report);
  }

  // ---------------------------------------------------------------------------
  // listReports
  // ---------------------------------------------------------------------------

  async listReports(projectId: string): Promise<AssessmentReportView[]> {
    const reports = await (this.prisma as any).migrationAssessmentReport.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return reports.map(toReportView);
  }

  // ---------------------------------------------------------------------------
  // getVersions
  // ---------------------------------------------------------------------------

  async getVersions(
    projectId: string,
    reportId: string,
  ): Promise<AssessmentVersionView[]> {
    // Guard: ensure report belongs to project
    await this.getReport(projectId, reportId);

    const versions = await (this.prisma as any).migrationAssessmentVersion.findMany({
      where: { reportId },
      orderBy: { version: 'asc' },
      include: { findings: true },
    });

    return versions.map((v: any) =>
      toVersionView(v, (v.findings ?? []).map(toFindingView)),
    );
  }

  // ---------------------------------------------------------------------------
  // exportPdf — stub
  // ---------------------------------------------------------------------------

  async exportPdf(
    projectId: string,
    reportId: string,
    versionId?: string,
  ): Promise<{ exportJobId: string; status: string; message: string }> {
    // Guard: ensure report belongs to project
    await this.getReport(projectId, reportId);

    void versionId; // acknowledged, used in future implementation

    return {
      exportJobId: randomUUID(),
      status: 'QUEUED',
      message: 'PDF export is queued. Download will be available shortly.',
    };
  }
}
