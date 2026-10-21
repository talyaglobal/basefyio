import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Req,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { RequestWithTraceId } from '../../common/middleware/trace-id.middleware';
import { AuditSinkService } from '../../common/audit/audit-sink.service';
import { toAuditEvent } from '../../common/audit/audit-event';
import { ObservabilityService } from './observability.service';

@Controller('observability')
@UseGuards(JwtAuthGuard, ManagementPermissionGuard)
export class ObservabilityController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly auditSink: AuditSinkService,
  ) {}

  @Get('root-alerts')
  @RequireManagementPermission('canViewRootAlerts')
  async listRootAlerts(@Query('limit') limit?: string) {
    return this.observability.listRootAlerts(limit ? Number(limit) : 100);
  }

  @Patch('root-alerts/:id/read')
  @RequireManagementPermission('canViewRootAlerts')
  async markRootAlertRead(@Param('id') id: string) {
    return this.observability.markRootAlertRead(id);
  }

  @Get('audit-logs')
  @RequireManagementPermission('canViewAuditLogs')
  async listAuditLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('severity') severity?: string,
    @Query('success') success?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.observability.listAuditLogs({
      page: page ? Math.floor(Number(page)) : undefined,
      limit: limit ? Math.floor(Number(limit)) : undefined,
      search: search?.trim() || undefined,
      severity: severity?.trim() || undefined,
      success: success?.trim() || undefined,
      dateFrom: dateFrom?.trim() || undefined,
      dateTo: dateTo?.trim() || undefined,
    });
  }

  @Get('audit-logs/:id')
  @RequireManagementPermission('canViewAuditLogs')
  async getAuditLog(@Param('id') id: string) {
    const row = await this.observability.getAuditLogById(id);
    if (!row) throw new NotFoundException('Audit log not found');
    return row;
  }

  /** Where audit records are forwarded and how the pipe is doing; destinations are redacted. */
  @Get('audit-sink')
  @RequireManagementPermission('canViewAuditLogs')
  auditSinkStatus() {
    return this.auditSink.stats();
  }

  /**
   * Sends one synthetic audit event to every configured destination and
   * reports whether each accepted it. Root only: it emits traffic to an
   * external system.
   */
  @Post('audit-sink/test')
  @UseGuards(RootRoleGuard)
  async auditSinkTest(@CurrentUser() user: JwtPayload, @Req() req: RequestWithTraceId) {
    if (!this.auditSink.enabled) {
      return { ok: false, enabled: false, targets: [], problems: this.auditSink.problems };
    }
    const result = await this.auditSink.sendTestEvent(
      toAuditEvent({
        source: 'test',
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        actorRole: 'ROOT',
        action: 'AUDIT_SINK_TEST',
        resourceType: 'audit-sink',
        resourceId: null,
        severity: 'LOW',
        success: true,
      }),
    );
    return { ...result, enabled: true, problems: this.auditSink.problems };
  }
}
