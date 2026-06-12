import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MigrationAssessmentsService } from './migration-assessments.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementKey } from '../entitlement/entitlement-key';

@Controller('v1/projects/:projectId/migration')
@UseGuards(JwtOrApiKeyGuard)
export class MigrationAssessmentsController {
  constructor(
    private readonly service: MigrationAssessmentsService,
    private readonly entitlementService: EntitlementService,
  ) {}

  // POST /v1/projects/:projectId/migration/archives/:archiveId/assessments
  @Post('archives/:archiveId/assessments')
  async createOrRunAssessment(
    @Param('projectId') projectId: string,
    @Param('archiveId') archiveId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ASSESSMENT_RUN);
    return this.service.createOrRunAssessment(projectId, archiveId, user.sub);
  }

  // GET /v1/projects/:projectId/migration/assessments
  @Get('assessments')
  async listReports(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ASSESSMENT_READ);
    return this.service.listReports(projectId);
  }

  // GET /v1/projects/:projectId/migration/assessments/:reportId
  @Get('assessments/:reportId')
  async getReport(
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ASSESSMENT_READ);
    return this.service.getReport(projectId, reportId);
  }

  // GET /v1/projects/:projectId/migration/assessments/:reportId/versions
  @Get('assessments/:reportId/versions')
  async getVersions(
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ASSESSMENT_READ);
    return this.service.getVersions(projectId, reportId);
  }

  // POST /v1/projects/:projectId/migration/assessments/:reportId/export-pdf
  @Post('assessments/:reportId/export-pdf')
  async exportPdf(
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
    @Body() body: { versionId?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.entitlementService.assertCan(projectId, EntitlementKey.MIGRATION_ASSESSMENT_READ);
    return this.service.exportPdf(projectId, reportId, body.versionId);
  }
}
