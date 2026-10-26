import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { StorageModule } from '../storage/storage.module';
import { PlatformAlertsModule } from '../platform-alerts/platform-alerts.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformStatusController } from './platform-status.controller';
import { PlatformStatusService } from './platform-status.service';
import { PlatformProberService } from './platform-prober.service';
import { StatusSubscriptionsService } from './status-subscriptions.service';

/**
 * Availability measurement: the internal prober, the samples endpoint for
 * external monitors, the 5-minute roll-ups, auto-opened incidents and the
 * payloads behind the public status page and the console's Reliability page.
 */
@Module({
  imports: [ProjectsModule, StorageModule, PlatformAlertsModule, AuthModule],
  controllers: [PlatformStatusController],
  providers: [PlatformStatusService, PlatformProberService, StatusSubscriptionsService],
  exports: [PlatformStatusService, StatusSubscriptionsService],
})
export class PlatformStatusModule {}
