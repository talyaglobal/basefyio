import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { StorageModule } from '../storage/storage.module';
import { RootConsoleController } from './root-console.controller';
import { RootConsoleService } from './root-console.service';
import { DiskUsageService } from './disk-usage.service';

@Module({
  imports: [PrismaModule, BillingModule, StorageModule],
  controllers: [RootConsoleController],
  providers: [RootConsoleService, DiskUsageService],
})
export class RootConsoleModule {}
