import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MarketingInsightsController } from './marketing-insights.controller';
import { MarketingInsightsService } from './marketing-insights.service';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';

@Module({
  imports: [PrismaModule],
  controllers: [MarketingInsightsController],
  providers: [MarketingInsightsService, ManagementPermissionGuard],
})
export class MarketingInsightsModule {}
