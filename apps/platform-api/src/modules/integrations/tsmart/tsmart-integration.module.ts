import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { TsmartIntegrationController } from './tsmart-integration.controller';
import { TsmartIntegrationGuard, TSMART_TOKEN_HASH_ENV, tsmartIntegrationState } from './tsmart-integration.guard';
import { TsmartIntegrationService } from './tsmart-integration.service';

/** Machine-to-machine project feed for tsmart.ai billing. PrismaModule is global. */
@Module({
  controllers: [TsmartIntegrationController],
  providers: [TsmartIntegrationService, TsmartIntegrationGuard],
})
export class TsmartIntegrationModule implements OnModuleInit {
  private readonly logger = new Logger(TsmartIntegrationModule.name);

  /** Say at boot whether the feed is on, so a mistyped hash is not a silent 404. */
  onModuleInit(): void {
    const state = tsmartIntegrationState();
    if (state.enabled) {
      this.logger.log('tsmart integration endpoint is enabled');
    } else if (state.reason === 'malformed') {
      this.logger.warn(
        `${TSMART_TOKEN_HASH_ENV} is set but is not 64 hex characters (length ${state.length}); the tsmart integration endpoint stays off`,
      );
    }
  }
}
