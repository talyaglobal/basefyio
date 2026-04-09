import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { UsageService } from './usage.service';
import { QuotaService } from './quota.service';
import { BillingScheduler } from './billing.scheduler';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { ObservabilityModule } from '../observability/observability.module';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { BillingProcessor } from '../queue/billing.processor';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [PrismaModule, ObservabilityModule, QueueModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    UsageService,
    QuotaService,
    BillingScheduler,
    BillingProcessor,
    RootRoleGuard,
    ManagementPermissionGuard,
  ],
  exports: [BillingService, UsageService, QuotaService],
})
export class BillingModule {}
