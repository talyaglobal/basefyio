import { describe, it, expect, vi } from 'vitest';
import { ArchivesClient } from './archives.js';
import type { BasefyioFetchClient } from '../lib/fetch.js';

function makeHttp(response: any): BasefyioFetchClient {
  return { json: vi.fn().mockResolvedValue(response) } as any;
}

describe('ArchivesClient', () => {
  const PROJECT = 'proj-abc';
  const ARCHIVE_ID = 'arc-123';
  const FILE_ID = 'file-456';

  describe('createArchive()', () => {
    it('POSTs to /v1/projects/:p/migration/archives with source and region', async () => {
      const archive = {
        id: ARCHIVE_ID,
        projectId: PROJECT,
        source: 'USER_UPLOAD',
        region: 'EU',
        status: 'PENDING',
        consentCompleted: false,
        bucketName: 'bucket-1',
        retention: '30d',
        totalBytes: '0',
        createdAt: '2026-01-01T00:00:00Z',
      };
      const http = makeHttp(archive);
      const client = new ArchivesClient(http);
      const result = await client.createArchive(PROJECT, { source: 'USER_UPLOAD', region: 'EU' });
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/migration/archives`);
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.source).toBe('USER_UPLOAD');
      expect(body.region).toBe('EU');
      expect(result.id).toBe(ARCHIVE_ID);
      expect(result.consentCompleted).toBe(false);
    });

    it('URL-encodes projectId in the create path', async () => {
      const http = makeHttp({ id: 'x', consentCompleted: false });
      const client = new ArchivesClient(http);
      await client.createArchive('proj 1', { source: 'WE_IMPORT', region: 'US' });
      expect((http.json as any).mock.calls[0][0]).toContain('proj%201');
    });
  });

  describe('getArchive()', () => {
    it('GETs the correct URL for a single archive', async () => {
      const archive = { id: ARCHIVE_ID, projectId: PROJECT, consentCompleted: true };
      const http = makeHttp(archive);
      const client = new ArchivesClient(http);
      const result = await client.getArchive(PROJECT, ARCHIVE_ID);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/migration/archives/${ARCHIVE_ID}`);
      expect(opts).toBeUndefined();
      expect(result.id).toBe(ARCHIVE_ID);
    });
  });

  describe('listFiles()', () => {
    it('GETs …/:archiveId/files and returns an array', async () => {
      const files = [
        { id: 'f1', archiveId: ARCHIVE_ID, filename: 'dump.sql', sizeBytes: '1024', uploadStatus: 'PENDING', uploadedBytes: '0', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'f2', archiveId: ARCHIVE_ID, filename: 'schema.sql', sizeBytes: '512', uploadStatus: 'COMPLETE', uploadedBytes: '512', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ];
      const http = makeHttp(files);
      const client = new ArchivesClient(http);
      const result = await client.listFiles(PROJECT, ARCHIVE_ID);
      const [url] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/migration/archives/${ARCHIVE_ID}/files`);
      expect(result).toHaveLength(2);
      expect(result[0].filename).toBe('dump.sql');
    });
  });

  describe('initiateFileUpload()', () => {
    it('POSTs to …/:archiveId/files with filename and sizeBytes in body', async () => {
      const file = {
        id: FILE_ID,
        archiveId: ARCHIVE_ID,
        filename: 'data.csv',
        sizeBytes: '2048',
        uploadStatus: 'PENDING',
        uploadedBytes: '0',
        resumeToken: 'tok-abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      const http = makeHttp(file);
      const client = new ArchivesClient(http);
      const result = await client.initiateFileUpload(PROJECT, ARCHIVE_ID, {
        filename: 'data.csv',
        sizeBytes: 2048,
      });
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/migration/archives/${ARCHIVE_ID}/files`);
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.filename).toBe('data.csv');
      expect(body.sizeBytes).toBe(2048);
      expect(result.resumeToken).toBe('tok-abc');
    });
  });

  describe('updateFileProgress()', () => {
    it('PATCHes …/files/:fileId/progress with { uploadedBytes }', async () => {
      const updated = {
        id: FILE_ID,
        archiveId: ARCHIVE_ID,
        filename: 'data.csv',
        sizeBytes: '2048',
        uploadStatus: 'IN_PROGRESS',
        uploadedBytes: '1024',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      const http = makeHttp(updated);
      const client = new ArchivesClient(http);
      const result = await client.updateFileProgress(PROJECT, ARCHIVE_ID, FILE_ID, 1024);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(
        `/v1/projects/${PROJECT}/migration/archives/${ARCHIVE_ID}/files/${FILE_ID}/progress`,
      );
      expect(opts.method).toBe('PATCH');
      expect(JSON.parse(opts.body)).toEqual({ uploadedBytes: 1024 });
      expect(result.uploadedBytes).toBe('1024');
    });
  });

  describe('recordConsent()', () => {
    it('POSTs to …/:archiveId/consent with correct URL-encoding', async () => {
      const http = makeHttp(undefined);
      const client = new ArchivesClient(http);
      const specialProject = 'proj/special';
      const specialArchive = 'arc/special';
      await client.recordConsent(specialProject, specialArchive, {
        ipAddress: '1.2.3.4',
        privacyStatementVersion: 'v1',
        riskStatementVersion: 'v1',
        archivePolicyVersion: 'v1',
        acceptedItems: ['PRIVACY', 'RISK', 'ARCHIVE_POLICY', 'DATA_RETENTION', 'ACCESS_CONTROL'],
      });
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toContain(encodeURIComponent(specialProject));
      expect(url).toContain(encodeURIComponent(specialArchive));
      expect(url).toMatch(/\/consent$/);
      expect(opts.method).toBe('POST');
    });

    it('sends all required consent fields in the body', async () => {
      const http = makeHttp(undefined);
      const client = new ArchivesClient(http);
      const consentInput = {
        ipAddress: '10.0.0.1',
        privacyStatementVersion: 'v2',
        riskStatementVersion: 'v2',
        archivePolicyVersion: 'v2',
        acceptedItems: ['PRIVACY', 'RISK', 'ARCHIVE_POLICY', 'DATA_RETENTION', 'ACCESS_CONTROL'],
        dbAccessAuthorized: true,
      };
      await client.recordConsent(PROJECT, ARCHIVE_ID, consentInput);
      const body = JSON.parse((http.json as any).mock.calls[0][1].body);
      expect(body.ipAddress).toBe('10.0.0.1');
      expect(body.acceptedItems).toHaveLength(5);
      expect(body.dbAccessAuthorized).toBe(true);
    });
  });

  describe('deleteArchive()', () => {
    it('DELETEs the correct archive URL', async () => {
      const http = makeHttp(undefined);
      const client = new ArchivesClient(http);
      await client.deleteArchive(PROJECT, ARCHIVE_ID);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/migration/archives/${ARCHIVE_ID}`);
      expect(opts.method).toBe('DELETE');
    });
  });

  describe('completeFileUpload()', () => {
    it('POSTs to …/files/:fileId/complete with optional checksum', async () => {
      const completed = {
        id: FILE_ID,
        archiveId: ARCHIVE_ID,
        filename: 'data.csv',
        sizeBytes: '2048',
        uploadStatus: 'COMPLETE',
        uploadedBytes: '2048',
        checksum: 'sha256-abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      const http = makeHttp(completed);
      const client = new ArchivesClient(http);
      const result = await client.completeFileUpload(PROJECT, ARCHIVE_ID, FILE_ID, 'sha256-abc');
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toContain('/complete');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ checksum: 'sha256-abc' });
      expect(result.uploadStatus).toBe('COMPLETE');
    });
  });
});
