import type { BasefyioFetchClient } from '../lib/fetch.js';

export interface AssessmentReport {
  id: string;
  projectId: string;
  archiveId: string;
  status: string;
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssessmentFinding {
  id: string;
  category: string;
  title: string;
  detail: string;
  riskLevel: string | null;
  metadata: unknown;
}

export interface AssessmentVersion {
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
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  findings: AssessmentFinding[];
}

export interface ExportPdfResult {
  exportJobId: string;
  status: string;
  message: string;
}

export class AssessmentsClient {
  constructor(private readonly http: BasefyioFetchClient) {}

  /** Trigger a new assessment for a migration archive. */
  async createAssessment(projectId: string, archiveId: string): Promise<AssessmentVersion> {
    return this.http.json<AssessmentVersion>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/assessments`,
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** List all assessment reports for a project. */
  async listReports(projectId: string): Promise<AssessmentReport[]> {
    return this.http.json<AssessmentReport[]>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/assessments`,
    );
  }

  /** Get a single assessment report by ID. */
  async getReport(projectId: string, reportId: string): Promise<AssessmentReport> {
    return this.http.json<AssessmentReport>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/assessments/${encodeURIComponent(reportId)}`,
    );
  }

  /** List all versions of an assessment report. */
  async getVersions(projectId: string, reportId: string): Promise<AssessmentVersion[]> {
    return this.http.json<AssessmentVersion[]>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/assessments/${encodeURIComponent(reportId)}/versions`,
    );
  }

  /** Export an assessment report version as a PDF. */
  async exportPdf(
    projectId: string,
    reportId: string,
    versionId?: string,
  ): Promise<ExportPdfResult> {
    return this.http.json<ExportPdfResult>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/assessments/${encodeURIComponent(reportId)}/export-pdf`,
      {
        method: 'POST',
        body: JSON.stringify(versionId !== undefined ? { versionId } : {}),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
