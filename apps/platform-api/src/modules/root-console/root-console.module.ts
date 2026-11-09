import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { StorageModule } from '../storage/storage.module';
import { PlatformAlertsModule } from '../platform-alerts/platform-alerts.module';
import { ProjectsModule } from '../projects/projects.module';
import { RootConsoleController } from './root-console.controller';
import { RootConsoleService } from './root-console.service';
import { DiskUsageService } from './disk-usage.service';
import { AuthModule } from '../auth/auth.module';
import { AuthUsersExportService } from './auth-users-export.service';
import { TechDocsService } from './tech-docs.service';

@Module({
  imports: [PrismaModule, BillingModule, StorageModule, PlatformAlertsModule, ProjectsModule, AuthModule],
  controllers: [RootConsoleController],
  providers: [RootConsoleService, DiskUsageService, TechDocsService, AuthUsersExportService],
})
export class RootConsoleModule {}
