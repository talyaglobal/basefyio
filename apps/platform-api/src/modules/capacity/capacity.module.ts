import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { PlatformAlertsModule } from '../platform-alerts/platform-alerts.module';
import { AuthModule } from '../auth/auth.module';
import { CapacityController } from './capacity.controller';
import { CapacitySamplerService } from './capacity-sampler.service';
import { CapacityModelService } from './capacity-model.service';

/**
 * How much the platform carries and how much more fits: a minute sampler on
 * the scheduler leader, a capacity model recomputed every 5 minutes, the
 * what-if simulation and the benchmark ledger behind the console's Capacity page.
 */
@Module({
  imports: [ProjectsModule, PlatformAlertsModule, AuthModule],
  controllers: [CapacityController],
  providers: [CapacitySamplerService, CapacityModelService],
  exports: [CapacityModelService],
})
export class CapacityModule {}
