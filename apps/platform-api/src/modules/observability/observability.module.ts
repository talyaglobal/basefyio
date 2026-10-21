import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ObservabilityController } from './observability.controller';
import { ObservabilityService } from './observability.service';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';

@Module({
  imports: [PrismaModule],
  controllers: [ObservabilityController],
  providers: [ObservabilityService, ManagementPermissionGuard, RootRoleGuard],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}

