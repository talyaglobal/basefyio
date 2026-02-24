import { Global, Module } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyGuard } from './api-key.guard';
import { JwtOrApiKeyGuard } from './jwt-or-apikey.guard';

@Global()
@Module({
  providers: [JwtAuthGuard, ApiKeyGuard, JwtOrApiKeyGuard],
  exports: [JwtAuthGuard, ApiKeyGuard, JwtOrApiKeyGuard],
})
export class GuardsModule {}
