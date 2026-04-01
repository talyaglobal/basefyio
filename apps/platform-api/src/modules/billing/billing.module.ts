import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { UsageService } from './usage.service';
import { QuotaService } from './quota.service';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController],
  providers: [BillingService, UsageService, QuotaService],
  exports: [BillingService, UsageService, QuotaService],
})
export class BillingModule {}
