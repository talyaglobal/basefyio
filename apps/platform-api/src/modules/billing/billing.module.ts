import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { UsageService } from './usage.service';
import { QuotaService } from './quota.service';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { ObservabilityModule } from '../observability/observability.module';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';

@Module({
  imports: [PrismaModule, ObservabilityModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    UsageService,
    QuotaService,
    RootRoleGuard,
    ManagementPermissionGuard,
  ],
  exports: [BillingService, UsageService, QuotaService],
})
export class BillingModule {}
