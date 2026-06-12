import type { BasefyioFetchClient } from '../lib/fetch.js';

export interface MigrationArchive {
  id: string;
  projectId: string;
  bucketName: string;
  status: string;
  source: string;
  retention: string;
  region: string;
  consentCompleted: boolean;
  totalBytes: string;
  createdAt: string;
  deletedAt?: string;
}

export interface MigrationArchiveFile {
  id: string;
  archiveId: string;
  filename: string;
  sizeBytes: string;
  contentType?: string;
  uploadStatus: string;
  uploadedBytes: string;
  chunkSize?: number;
  checksum?: string;
  resumeToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateArchiveInput {
  source: 'USER_UPLOAD' | 'WE_IMPORT';
  region: string;
  retention?: string;
}

export interface InitiateFileUploadInput {
  filename: string;
  sizeBytes: number;
  contentType?: string;
  chunkSize?: number;
}

export interface RecordConsentInput {
  ipAddress: string;
  privacyStatementVersion: string;
  riskStatementVersion: string;
  archivePolicyVersion: string;
  acceptedItems: string[];
  sensitiveDataFlags?: Record<string, boolean>;
  dbAccessAuthorized?: boolean;
}

export class ArchivesClient {
  constructor(private readonly http: BasefyioFetchClient) {}

  /** Create a new migration archive for a project. */
  async createArchive(projectId: string, input: CreateArchiveInput): Promise<MigrationArchive> {
    return this.http.json<MigrationArchive>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives`,
      {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** Get a single migration archive by ID. */
  async getArchive(projectId: string, archiveId: string): Promise<MigrationArchive> {
    return this.http.json<MigrationArchive>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}`,
    );
  }

  /** List all files in a migration archive. */
  async listFiles(projectId: string, archiveId: string): Promise<MigrationArchiveFile[]> {
    return this.http.json<MigrationArchiveFile[]>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/files`,
    );
  }

  /** Initiate a file upload within a migration archive. */
  async initiateFileUpload(
    projectId: string,
    archiveId: string,
    input: InitiateFileUploadInput,
  ): Promise<MigrationArchiveFile> {
    return this.http.json<MigrationArchiveFile>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/files`,
      {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** Update upload progress for a file. */
  async updateFileProgress(
    projectId: string,
    archiveId: string,
    fileId: string,
    uploadedBytes: number,
  ): Promise<MigrationArchiveFile> {
    return this.http.json<MigrationArchiveFile>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/files/${encodeURIComponent(fileId)}/progress`,
      {
        method: 'PATCH',
        body: JSON.stringify({ uploadedBytes }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** Mark a file upload as complete. */
  async completeFileUpload(
    projectId: string,
    archiveId: string,
    fileId: string,
    checksum?: string,
  ): Promise<MigrationArchiveFile> {
    return this.http.json<MigrationArchiveFile>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/files/${encodeURIComponent(fileId)}/complete`,
      {
        method: 'POST',
        body: JSON.stringify(checksum !== undefined ? { checksum } : {}),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** Record consent for a migration archive. */
  async recordConsent(
    projectId: string,
    archiveId: string,
    input: RecordConsentInput,
  ): Promise<void> {
    await this.http.json<void>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/consent`,
      {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** Delete a migration archive. */
  async deleteArchive(projectId: string, archiveId: string): Promise<void> {
    await this.http.json<void>(
      `/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}`,
      { method: 'DELETE' },
    );
  }
}
