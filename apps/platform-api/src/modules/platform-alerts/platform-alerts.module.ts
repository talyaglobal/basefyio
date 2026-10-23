import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { PlatformAlertsService } from './platform-alerts.service';
import { PlatformHealthService, REALM_PROBE } from './platform-health.service';

@Module({
  imports: [AuthModule],
  providers: [
    PlatformAlertsService,
    PlatformHealthService,
    { provide: REALM_PROBE, useExisting: KeycloakAdminService },
  ],
  exports: [PlatformAlertsService],
})
export class PlatformAlertsModule {}
