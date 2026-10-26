import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyGuard } from './api-key.guard';
import { JwtOrApiKeyGuard } from './jwt-or-apikey.guard';
import { FrozenAccountInterceptor } from '../interceptors/frozen-account.interceptor';
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
    RateLimitGuard,
    ModuleEnabledGuard,
    // The freeze check runs as an interceptor: global guards run before the
    // route's own guards, so as a guard it never saw request.user.
    { provide: APP_INTERCEPTOR, useClass: FrozenAccountInterceptor },
  ],
  exports: [JwtAuthGuard, ApiKeyGuard, JwtOrApiKeyGuard, RateLimitGuard, ModuleEnabledGuard],
})
export class GuardsModule {}
