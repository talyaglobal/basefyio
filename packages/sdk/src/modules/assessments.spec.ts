import { describe, it, expect, vi } from 'vitest';
import { AssessmentsClient } from './assessments.js';
import type { BasefyioFetchClient } from '../lib/fetch.js';

function makeHttp(response: any): BasefyioFetchClient {
  return { json: vi.fn().mockResolvedValue(response) } as any;
}

describe('AssessmentsClient', () => {
  const PROJECT = 'proj-abc';
  const ARCHIVE_ID = 'arc-123';
  const REPORT_ID = 'report-456';
  const VERSION_ID = 'ver-789';

  const MOCK_VERSION = {
    id: VERSION_ID,
    reportId: REPORT_ID,
    versionNumber: 1,
    status: 'READY',
    confidencePct: 0.85,
    complexity: 'MEDIUM',
    riskLevel: 'MEDIUM',
    tablesFound: 5,
    findings: [],
    createdAt: '2026-01-01T00:00:00Z',
  };

  const MOCK_REPORT = {
    id: REPORT_ID,
    projectId: PROJECT,
    archiveId: ARCHIVE_ID,
    latestVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  describe('createAssessment()', () => {
    it('POSTs to a URL that contains the archiveId and /assessments', async () => {
      const http = makeHttp(MOCK_VERSION);
      const client = new AssessmentsClient(http);
      await client.createAssessment(PROJECT, ARCHIVE_ID);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toContain(ARCHIVE_ID);
      expect(url).toMatch(/\/assessments$/);
      expect(opts.method).toBe('POST');
    });

    it('URL-encodes projectId in the create path', async () => {
      const http = makeHttp(MOCK_VERSION);
      const client = new AssessmentsClient(http);
      await client.createAssessment('proj 1', ARCHIVE_ID);
      const [url] = (http.json as any).mock.calls[0];
      expect(url).toContain('proj%201');
    });
  });

  describe('listReports()', () => {
    it('GETs /v1/projects/:p/migration/assessments', async () => {
      const http = makeHttp([MOCK_REPORT]);
      const client = new AssessmentsClient(http);
      await client.listReports(PROJECT);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/migration/assessments`);
      expect(opts).toBeUndefined();
    });

    it('returns an array from the response', async () => {
      const http = makeHttp([MOCK_REPORT, { ...MOCK_REPORT, id: 'report-2' }]);
      const client = new AssessmentsClient(http);
      const result = await client.listReports(PROJECT);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(REPORT_ID);
    });
  });

  describe('getReport()', () => {
    it('GETs the correct URL for a single report', async () => {
      const http = makeHttp(MOCK_REPORT);
      const client = new AssessmentsClient(http);
      const result = await client.getReport(PROJECT, REPORT_ID);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/migration/assessments/${REPORT_ID}`);
      expect(opts).toBeUndefined();
      expect(result.id).toBe(REPORT_ID);
    });
  });

  describe('getVersions()', () => {
    it('GETs …/assessments/:reportId/versions', async () => {
      const http = makeHttp([MOCK_VERSION]);
      const client = new AssessmentsClient(http);
      const result = await client.getVersions(PROJECT, REPORT_ID);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(
        `/v1/projects/${PROJECT}/migration/assessments/${REPORT_ID}/versions`,
      );
      expect(opts).toBeUndefined();
      expect(result).toHaveLength(1);
    });
  });

  describe('exportPdf()', () => {
    it('POSTs to …/assessments/:reportId/export-pdf with an empty body when no versionId', async () => {
      const http = makeHttp({ exportJobId: 'job-1', status: 'QUEUED', message: 'queued' });
      const client = new AssessmentsClient(http);
      await client.exportPdf(PROJECT, REPORT_ID);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(
        `/v1/projects/${PROJECT}/migration/assessments/${REPORT_ID}/export-pdf`,
      );
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({});
    });

    it('includes versionId in the request body when provided', async () => {
      const http = makeHttp({ exportJobId: 'job-2', status: 'QUEUED', message: 'queued' });
      const client = new AssessmentsClient(http);
      await client.exportPdf(PROJECT, REPORT_ID, VERSION_ID);
      const body = JSON.parse((http.json as any).mock.calls[0][1].body);
      expect(body.versionId).toBe(VERSION_ID);
    });
  });
});
