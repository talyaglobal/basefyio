import { Module } from '@nestjs/common';
import { FeaturesController } from './features.controller';
import { FeatureFlagsService } from './feature-flags.service';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';

@Module({
  controllers: [FeaturesController],
  providers: [FeatureFlagsService, ManagementPermissionGuard],
  exports: [FeatureFlagsService],
})
export class FeaturesModule {}
