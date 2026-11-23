import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PayPalService } from './paypal.service';
import { UsageService } from './usage.service';
import { QuotaService } from './quota.service';
import { ProjectCostService } from './project-cost.service';
import { BillingScheduler } from './billing.scheduler';
import { StripeSummaryScheduler } from './stripe-summary.scheduler';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { ObservabilityModule } from '../observability/observability.module';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { BillingProcessor } from '../queue/billing.processor';
import { QueueModule } from '../queue/queue.module';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';
import { RedisModule } from '../redis/redis.module';
import { EmailModule } from '../email/email.module';
import { QuickbooksModule } from '../quickbooks/quickbooks.module';
import { PlanEnforcementService } from './plan-enforcement.service';
import { PlanGateInterceptor } from './plan-gate.interceptor';
import { PlanUsageAlertsService } from './plan-usage-alerts.service';
import { PlanLimitsController } from './plan-limits.controller';

@Module({
  imports: [PrismaModule, ObservabilityModule, QueueModule, RedisModule, EmailModule, QuickbooksModule],
  controllers: [BillingController, PlanLimitsController],
  providers: [
    BillingService,
    PayPalService,
    UsageService,
    QuotaService,
    ProjectCostService,
    BillingScheduler,
    StripeSummaryScheduler,
    BillingProcessor,
    RootRoleGuard,
    ManagementPermissionGuard,
    RealtimeEventsService,
    RealtimeStreamService,
    PlanEnforcementService,
    PlanUsageAlertsService,
    // Global: routes marked @PlanGate are checked against the plan limits.
    { provide: APP_INTERCEPTOR, useClass: PlanGateInterceptor },
  ],
  exports: [BillingService, UsageService, QuotaService, ProjectCostService, PlanEnforcementService],
})
export class BillingModule {}
