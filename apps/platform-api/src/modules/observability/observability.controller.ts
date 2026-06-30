import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { ObservabilityService } from './observability.service';

@Controller('observability')
@UseGuards(JwtAuthGuard, ManagementPermissionGuard)
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

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
}

