import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { JwtOrPlatformTokenGuard } from './jwt-or-platform-token.guard';
import { ScopesGuard } from './scopes.guard';

/**
 * Global so JwtOrPlatformTokenGuard / ScopesGuard can be applied on any
 * management controller (via @UseGuards + @Scopes) without extra imports.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [ApiTokensController],
  providers: [ApiTokensService, JwtOrPlatformTokenGuard, ScopesGuard],
  exports: [ApiTokensService, JwtOrPlatformTokenGuard, ScopesGuard],
})
export class ApiTokensModule {}
