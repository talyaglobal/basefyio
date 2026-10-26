import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { StorageModule } from '../storage/storage.module';
import { PlatformAlertsModule } from '../platform-alerts/platform-alerts.module';
import { ProjectsModule } from '../projects/projects.module';
import { RootConsoleController } from './root-console.controller';
import { RootConsoleService } from './root-console.service';
import { DiskUsageService } from './disk-usage.service';
import { TechDocsService } from './tech-docs.service';

@Module({
  imports: [PrismaModule, BillingModule, StorageModule, PlatformAlertsModule, ProjectsModule],
  controllers: [RootConsoleController],
  providers: [RootConsoleService, DiskUsageService, TechDocsService],
})
export class RootConsoleModule {}
