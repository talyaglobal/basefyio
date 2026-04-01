import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { HttpModule } from '@nestjs/axios';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [PassportModule, HttpModule, BillingModule],
  controllers: [AuthController],
  providers: [AuthService, KeycloakAdminService, JwtStrategy],
  exports: [KeycloakAdminService],
})
export class AuthModule {}
