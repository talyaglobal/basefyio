import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { HttpModule } from '@nestjs/axios';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { PlatformMfaService } from './platform-mfa.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { BillingModule } from '../billing/billing.module';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { ObservabilityModule } from '../observability/observability.module';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { OrganizationsCoreModule } from '../organizations/organizations-core.module';

@Module({
  imports: [PassportModule, HttpModule, BillingModule, ObservabilityModule, OrganizationsCoreModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    KeycloakAdminService,
    PlatformMfaService,
    JwtStrategy,
    RootRoleGuard,
    ManagementPermissionGuard,
  ],
  exports: [KeycloakAdminService, PlatformMfaService],
})
export class AuthModule {}
