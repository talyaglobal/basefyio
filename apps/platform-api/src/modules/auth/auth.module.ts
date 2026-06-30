import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { HttpModule } from '@nestjs/axios';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { ObservabilityModule } from '../observability/observability.module';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';

@Module({
  imports: [PassportModule, HttpModule, ObservabilityModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    KeycloakAdminService,
    JwtStrategy,
    RootRoleGuard,
    ManagementPermissionGuard,
  ],
  exports: [KeycloakAdminService],
})
export class AuthModule {}
