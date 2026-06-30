import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { MarketingInsightsService } from './marketing-insights.service';

@Controller('auth/management/marketing')
export class MarketingInsightsController {
  private readonly logger = new Logger(MarketingInsightsController.name);

  constructor(private readonly marketing: MarketingInsightsService) {}

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canAccessManagement')
  @Get('search-console')
  async searchConsole() {
    try {
      return await this.marketing.getSearchConsoleSummary();
    } catch (err: any) {
      this.logger.error(`Search Console fetch failed: ${err.message}`, err.stack);
      return { configured: true, error: err.message };
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canAccessManagement')
  @Get('analytics/traffic')
  async analyticsTraffic() {
    try {
      return await this.marketing.getAnalyticsTraffic();
    } catch (err: any) {
      this.logger.error(`Analytics fetch failed: ${err.message}`, err.stack);
      return { configured: true, error: err.message };
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canAccessManagement')
  @Get('distribution')
  async distribution() {
    try {
      return await this.marketing.getDistributionStats();
    } catch (err: any) {
      this.logger.error(`Distribution stats fetch failed: ${err.message}`, err.stack);
      return { configured: true, error: err.message };
    }
  }
}
