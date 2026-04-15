import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { MarketingInsightsService } from './marketing-insights.service';

@Controller('auth/management/marketing')
export class MarketingInsightsController {
  constructor(private readonly marketing: MarketingInsightsService) {}

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canAccessManagement')
  @Get('search-console')
  async searchConsole() {
    return this.marketing.getSearchConsoleSummary();
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canAccessManagement')
  @Get('analytics/traffic')
  async analyticsTraffic() {
    return this.marketing.getAnalyticsTraffic();
  }
}
