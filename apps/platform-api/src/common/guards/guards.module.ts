import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyGuard } from './api-key.guard';
import { JwtOrApiKeyGuard } from './jwt-or-apikey.guard';
import { FrozenAccountGuard } from './frozen-account.guard';
import { RateLimitGuard } from './rate-limit.guard';
import { ModuleEnabledGuard } from './module-enabled.guard';
import { AuthModule } from '../../modules/auth/auth.module';

@Global()
@Module({
  // AuthModule for the realm the API-key guard re-enables when a request
  // activates a deactivated project; without it the guard would be built
  // without a Keycloak client and sign-in would stay closed after activation.
  imports: [AuthModule],
  providers: [
    JwtAuthGuard,
    ApiKeyGuard,
    JwtOrApiKeyGuard,
    FrozenAccountGuard,
    RateLimitGuard,
    ModuleEnabledGuard,
    { provide: APP_GUARD, useClass: FrozenAccountGuard },
  ],
  exports: [JwtAuthGuard, ApiKeyGuard, JwtOrApiKeyGuard, RateLimitGuard, ModuleEnabledGuard],
})
export class GuardsModule {}
