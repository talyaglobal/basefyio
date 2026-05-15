import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyGuard } from './api-key.guard';
import { JwtOrApiKeyGuard } from './jwt-or-apikey.guard';
import { FrozenAccountGuard } from './frozen-account.guard';
import { RateLimitGuard } from './rate-limit.guard';

@Global()
@Module({
  providers: [
    JwtAuthGuard,
    ApiKeyGuard,
    JwtOrApiKeyGuard,
    FrozenAccountGuard,
    RateLimitGuard,
    { provide: APP_GUARD, useClass: FrozenAccountGuard },
  ],
  exports: [JwtAuthGuard, ApiKeyGuard, JwtOrApiKeyGuard, RateLimitGuard],
})
export class GuardsModule {}
