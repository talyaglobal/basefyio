import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { UsageService } from './usage.service';
import { QuotaService } from './quota.service';
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

@Module({
  imports: [PrismaModule, ObservabilityModule, QueueModule, RedisModule, EmailModule, QuickbooksModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    UsageService,
    QuotaService,
    BillingScheduler,
    StripeSummaryScheduler,
    BillingProcessor,
    RootRoleGuard,
    ManagementPermissionGuard,
    RealtimeEventsService,
    RealtimeStreamService,
  ],
  exports: [BillingService, UsageService, QuotaService],
})
export class BillingModule {}
