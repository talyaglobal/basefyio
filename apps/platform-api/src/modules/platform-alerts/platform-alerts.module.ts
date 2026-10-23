import { Module } from '@nestjs/common';
import { PlatformAlertsService } from './platform-alerts.service';

@Module({
  providers: [PlatformAlertsService],
  exports: [PlatformAlertsService],
})
export class PlatformAlertsModule {}
