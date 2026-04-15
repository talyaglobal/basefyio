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
  async listAuditLogs(@Query('limit') limit?: string) {
    if (limit == null || limit.trim() === '') {
      return this.observability.listAuditLogs(undefined);
    }
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) {
      return this.observability.listAuditLogs(undefined);
    }
    return this.observability.listAuditLogs(Math.floor(n));
  }

  @Get('audit-logs/:id')
  @RequireManagementPermission('canViewAuditLogs')
  async getAuditLog(@Param('id') id: string) {
    const row = await this.observability.getAuditLogById(id);
    if (!row) throw new NotFoundException('Audit log not found');
    return row;
  }
}

