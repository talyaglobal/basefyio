import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

// ── View interfaces ────────────────────────────────────────────────────────────
// Internal fields (objectKey, encryptedAtRest, etc.) are intentionally omitted.

export interface MigrationArchiveView {
  id: string;
  projectId: string;
  bucketName: string;
  status: string;
  source: string;
  retention: string;
  region: string;
  consentCompleted: boolean;
  totalBytes: string;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface MigrationArchiveFileView {
  id: string;
  archiveId: string;
  filename: string;
  sizeBytes: string;
  contentType: string | null;
  uploadStatus: string;
  uploadedBytes: string;
  chunkSize: number | null;
  checksum: string | null;
  resumeToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Required consent items ────────────────────────────────────────────────────

const REQUIRED_CONSENT_ITEMS = [
  'privacy_statement',
  'data_ownership',
  'ai_analysis_consent',
  'migration_risk_acceptance',
  'database_access_authorization',
] as const;

// ── Helper mappers ─────────────────────────────────────────────────────────────

function toArchiveView(row: {
  id: string;
  projectId: string;
  bucketName: string;
  status: string;
  source: string;
  retention: string;
  region: string;
  consentCompletedAt: Date | null;
  totalBytes: bigint;
  createdAt: Date;
  deletedAt: Date | null;
}): MigrationArchiveView {
  return {
    id: row.id,
    projectId: row.projectId,
    bucketName: row.bucketName,
    status: row.status,
    source: row.source,
    retention: row.retention,
    region: row.region,
    consentCompleted: row.consentCompletedAt !== null,
    totalBytes: row.totalBytes.toString(),
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

function toFileView(row: {
  id: string;
  archiveId: string;
  filename: string;
  sizeBytes: bigint;
  contentType: string | null;
  uploadStatus: string;
  uploadedBytes: bigint;
  chunkSize: number | null;
  checksum: string | null;
  resumeToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MigrationArchiveFileView {
  return {
    id: row.id,
    archiveId: row.archiveId,
    filename: row.filename,
    sizeBytes: row.sizeBytes.toString(),
    contentType: row.contentType,
    uploadStatus: row.uploadStatus,
    uploadedBytes: row.uploadedBytes.toString(),
    chunkSize: row.chunkSize,
    checksum: row.checksum,
    resumeToken: row.resumeToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class MigrationArchivesService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // assertProjectMember — same pattern as DataStructuresService
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
  // createArchive
  // ---------------------------------------------------------------------------

  async createArchive(
    projectId: string,
    dto: {
      source: 'USER_UPLOAD' | 'WE_IMPORT';
      region: string;
      retention?: string;
    },
  ): Promise<MigrationArchiveView> {
    const retention = dto.retention ?? 'STANDARD_1Y';

    // Derive a deterministic bucket name from projectId + timestamp
    const bucketName = `migration-${projectId}-${Date.now()}`;

    // TODO: Create the MinIO bucket here before setting status to ACTIVE.
    //   e.g. await this.minioService.makeBucket(bucketName, dto.region);

    const archive = await this.prisma.migrationArchive.create({
      data: {
        projectId,
        bucketName,
        status: 'CREATING',
        source: dto.source as any,
        retention: retention as any,
        region: dto.region,
      },
      select: {
        id: true,
        projectId: true,
        bucketName: true,
        status: true,
        source: true,
        retention: true,
        region: true,
        consentCompletedAt: true,
        totalBytes: true,
        createdAt: true,
        deletedAt: true,
      },
    });

    // Update status to ACTIVE immediately (real code would await bucket creation)
    const updated = await this.prisma.migrationArchive.update({
      where: { id: archive.id },
      data: { status: 'ACTIVE' },
      select: {
        id: true,
        projectId: true,
        bucketName: true,
        status: true,
        source: true,
        retention: true,
        region: true,
        consentCompletedAt: true,
        totalBytes: true,
        createdAt: true,
        deletedAt: true,
      },
    });

    return toArchiveView(updated);
  }

  // ---------------------------------------------------------------------------
  // getArchive
  // ---------------------------------------------------------------------------

  async getArchive(projectId: string, archiveId: string): Promise<MigrationArchiveView> {
    const archive = await this.prisma.migrationArchive.findFirst({
      where: { id: archiveId, projectId },
      select: {
        id: true,
        projectId: true,
        bucketName: true,
        status: true,
        source: true,
        retention: true,
        region: true,
        consentCompletedAt: true,
        totalBytes: true,
        createdAt: true,
        deletedAt: true,
      },
    });

    if (!archive) {
      throw new NotFoundException('Migration archive not found');
    }

    return toArchiveView(archive);
  }

  // ---------------------------------------------------------------------------
  // listArchiveFiles
  // ---------------------------------------------------------------------------

  async listArchiveFiles(
    projectId: string,
    archiveId: string,
  ): Promise<MigrationArchiveFileView[]> {
    // Ensure archive belongs to project
    await this.getArchive(projectId, archiveId);

    const files = await this.prisma.migrationArchiveFile.findMany({
      where: { archiveId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        archiveId: true,
        filename: true,
        sizeBytes: true,
        contentType: true,
        uploadStatus: true,
        uploadedBytes: true,
        chunkSize: true,
        checksum: true,
        resumeToken: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return files.map(toFileView);
  }

  // ---------------------------------------------------------------------------
  // initiateFileUpload
  // ---------------------------------------------------------------------------

  async initiateFileUpload(
    projectId: string,
    archiveId: string,
    dto: {
      filename: string;
      sizeBytes: number;
      contentType?: string;
      chunkSize?: number;
    },
  ): Promise<MigrationArchiveFileView> {
    // Ensure archive belongs to project and is active
    const archive = await this.getArchive(projectId, archiveId);
    if (archive.status !== 'ACTIVE') {
      throw new BadRequestException('Archive must be ACTIVE to accept file uploads');
    }

    // Content is immutable: derive objectKey from archiveId + filename
    const objectKey = `${archiveId}/${Date.now()}-${dto.filename}`;
    const resumeToken = randomUUID();

    const file = await this.prisma.migrationArchiveFile.create({
      data: {
        archiveId,
        filename: dto.filename,
        objectKey,
        sizeBytes: dto.sizeBytes,
        contentType: dto.contentType ?? null,
        uploadStatus: 'PENDING',
        uploadedBytes: 0,
        chunkSize: dto.chunkSize ?? null,
        resumeToken,
      },
      select: {
        id: true,
        archiveId: true,
        filename: true,
        sizeBytes: true,
        contentType: true,
        uploadStatus: true,
        uploadedBytes: true,
        chunkSize: true,
        checksum: true,
        resumeToken: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return toFileView(file);
  }

  // ---------------------------------------------------------------------------
  // updateFileProgress
  // ---------------------------------------------------------------------------

  async updateFileProgress(
    projectId: string,
    archiveId: string,
    fileId: string,
    uploadedBytes: number,
  ): Promise<MigrationArchiveFileView> {
    // Ensure archive belongs to project
    await this.getArchive(projectId, archiveId);

    const file = await this.prisma.migrationArchiveFile.findFirst({
      where: { id: fileId, archiveId },
    });
    if (!file) throw new NotFoundException('Archive file not found');

    const updated = await this.prisma.migrationArchiveFile.update({
      where: { id: fileId },
      data: {
        uploadedBytes,
        uploadStatus: 'UPLOADING',
      },
      select: {
        id: true,
        archiveId: true,
        filename: true,
        sizeBytes: true,
        contentType: true,
        uploadStatus: true,
        uploadedBytes: true,
        chunkSize: true,
        checksum: true,
        resumeToken: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return toFileView(updated);
  }

  // ---------------------------------------------------------------------------
  // completeFileUpload
  // ---------------------------------------------------------------------------

  async completeFileUpload(
    projectId: string,
    archiveId: string,
    fileId: string,
    checksum?: string,
  ): Promise<MigrationArchiveFileView> {
    // Ensure archive belongs to project
    await this.getArchive(projectId, archiveId);

    const file = await this.prisma.migrationArchiveFile.findFirst({
      where: { id: fileId, archiveId },
    });
    if (!file) throw new NotFoundException('Archive file not found');

    const updated = await this.prisma.migrationArchiveFile.update({
      where: { id: fileId },
      data: {
        uploadStatus: 'COMPLETE',
        uploadedBytes: file.sizeBytes,
        checksum: checksum ?? null,
      },
      select: {
        id: true,
        archiveId: true,
        filename: true,
        sizeBytes: true,
        contentType: true,
        uploadStatus: true,
        uploadedBytes: true,
        chunkSize: true,
        checksum: true,
        resumeToken: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Update archive.totalBytes by summing all completed files
    const aggregate = await this.prisma.migrationArchiveFile.aggregate({
      where: { archiveId, uploadStatus: 'COMPLETE' },
      _sum: { sizeBytes: true },
    });

    const totalBytes = aggregate._sum.sizeBytes ?? BigInt(0);
    await this.prisma.migrationArchive.update({
      where: { id: archiveId },
      data: { totalBytes },
    });

    return toFileView(updated);
  }

  // ---------------------------------------------------------------------------
  // recordConsent
  // ---------------------------------------------------------------------------

  async recordConsent(
    projectId: string,
    archiveId: string,
    userId: string,
    dto: {
      ipAddress: string;
      privacyStatementVersion: string;
      riskStatementVersion: string;
      archivePolicyVersion: string;
      acceptedItems: string[];
      sensitiveDataFlags?: Record<string, boolean>;
      dbAccessAuthorized?: boolean;
    },
  ): Promise<void> {
    // Ensure archive belongs to project
    await this.getArchive(projectId, archiveId);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const teamId = project.teamId;

    // Validate all 5 required consent items are present
    const missing = REQUIRED_CONSENT_ITEMS.filter(
      (item) => !dto.acceptedItems.includes(item),
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required consent items: [${missing.join(', ')}]`,
      );
    }

    const now = new Date();

    // Create immutable consent record (re-consent always creates a new row)
    await this.prisma.migrationConsent.create({
      data: {
        archiveId,
        projectId,
        userId,
        teamId,
        acceptedAt: now,
        ipAddress: dto.ipAddress,
        privacyStatementVersion: dto.privacyStatementVersion,
        riskStatementVersion: dto.riskStatementVersion,
        archivePolicyVersion: dto.archivePolicyVersion,
        acceptedItems: dto.acceptedItems as any,
        sensitiveDataFlags: (dto.sensitiveDataFlags ?? {}) as any,
        dbAccessAuthorized: dto.dbAccessAuthorized ?? false,
      },
    });

    // Set archive.consentCompletedAt after all 5 items are confirmed
    await this.prisma.migrationArchive.update({
      where: { id: archiveId },
      data: { consentCompletedAt: now },
    });

    // Write to AuditLog
    await this.prisma.auditLog.create({
      data: {
        traceId: randomUUID(),
        actorUserId: userId,
        actorRole: 'USER',
        action: 'MIGRATION_CONSENT_RECORDED',
        resourceType: 'MigrationArchive',
        resourceId: archiveId,
        severity: 'INFO',
        success: true,
        metadataJson: {
          projectId,
          archiveId,
          privacyStatementVersion: dto.privacyStatementVersion,
          riskStatementVersion: dto.riskStatementVersion,
          archivePolicyVersion: dto.archivePolicyVersion,
          acceptedItems: dto.acceptedItems,
          dbAccessAuthorized: dto.dbAccessAuthorized ?? false,
        } as any,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // deleteArchive (soft-delete)
  // ---------------------------------------------------------------------------

  async deleteArchive(projectId: string, archiveId: string): Promise<void> {
    // Ensure archive belongs to project
    await this.getArchive(projectId, archiveId);

    // Require no active uploads
    const activeUploads = await this.prisma.migrationArchiveFile.count({
      where: {
        archiveId,
        uploadStatus: { in: ['PENDING', 'UPLOADING'] },
      },
    });
    if (activeUploads > 0) {
      throw new BadRequestException(
        'Cannot delete archive while file uploads are in progress',
      );
    }

    await this.prisma.migrationArchive.update({
      where: { id: archiveId },
      data: {
        deletedAt: new Date(),
        status: 'DELETED',
      },
    });
  }
}
