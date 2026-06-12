import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MigrationArchivesService } from './migration-archives.service';
import { CreateArchiveDto } from './dto/create-archive.dto';
import { InitiateFileUploadDto } from './dto/initiate-file-upload.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementKey } from '../entitlement/entitlement-key';

@Controller('v1/projects/:projectId/migration/archives')
@UseGuards(JwtOrApiKeyGuard)
export class MigrationArchivesController {
  constructor(
    private readonly service: MigrationArchivesService,
    private readonly entitlementService: EntitlementService,
  ) {}

  @Post()
  async createArchive(
    @Param('projectId') projectId: string,
    @Body() body: CreateArchiveDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ARCHIVE_CREATE);
    return this.service.createArchive(projectId, body);
  }

  @Get(':archiveId')
  async getArchive(
    @Param('projectId') projectId: string,
    @Param('archiveId') archiveId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ARCHIVE_READ);
    return this.service.getArchive(projectId, archiveId);
  }

  @Get(':archiveId/files')
  async listArchiveFiles(
    @Param('projectId') projectId: string,
    @Param('archiveId') archiveId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ARCHIVE_READ);
    return this.service.listArchiveFiles(projectId, archiveId);
  }

  @Post(':archiveId/files')
  async initiateFileUpload(
    @Param('projectId') projectId: string,
    @Param('archiveId') archiveId: string,
    @Body() body: InitiateFileUploadDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ARCHIVE_CREATE);
    return this.service.initiateFileUpload(projectId, archiveId, body);
  }

  @Patch(':archiveId/files/:fileId/progress')
  async updateFileProgress(
    @Param('projectId') projectId: string,
    @Param('archiveId') archiveId: string,
    @Param('fileId') fileId: string,
    @Body() body: { uploadedBytes: number },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ARCHIVE_CREATE);
    return this.service.updateFileProgress(projectId, archiveId, fileId, body.uploadedBytes);
  }

  @Post(':archiveId/files/:fileId/complete')
  async completeFileUpload(
    @Param('projectId') projectId: string,
    @Param('archiveId') archiveId: string,
    @Param('fileId') fileId: string,
    @Body() body: { checksum?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ARCHIVE_CREATE);
    return this.service.completeFileUpload(projectId, archiveId, fileId, body.checksum);
  }

  @Post(':archiveId/consent')
  async recordConsent(
    @Param('projectId') projectId: string,
    @Param('archiveId') archiveId: string,
    @Body() body: {
      ipAddress: string;
      privacyStatementVersion: string;
      riskStatementVersion: string;
      archivePolicyVersion: string;
      acceptedItems: string[];
      sensitiveDataFlags?: Record<string, boolean>;
      dbAccessAuthorized?: boolean;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ARCHIVE_CREATE);
    return this.service.recordConsent(projectId, archiveId, user.sub, body);
  }

  @Delete(':archiveId')
  async deleteArchive(
    @Param('projectId') projectId: string,
    @Param('archiveId') archiveId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ARCHIVE_CREATE);
    return this.service.deleteArchive(projectId, archiveId);
  }
}
