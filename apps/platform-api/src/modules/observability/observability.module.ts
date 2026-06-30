import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ObservabilityController } from './observability.controller';
import { ObservabilityService } from './observability.service';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';

@Module({
  imports: [PrismaModule],
  controllers: [ObservabilityController],
  providers: [ObservabilityService, ManagementPermissionGuard],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}

