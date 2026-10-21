import { Global, Module } from '@nestjs/common';
import { RealtimeDataService } from './realtime-data.service';
import { RealtimeFanoutService } from './realtime-fanout.service';
import { RealtimePolicyService } from './realtime-policy.service';
import { RealtimePresenceService } from './realtime-presence.service';
import { RealtimeBroadcastService } from './realtime-broadcast.service';
import { QueryAccessTokenGuard } from './query-access-token.guard';
import {
  RealtimeApiController,
  RealtimeBindingsController,
  RealtimeDataStreamController,
} from './realtime-data.controller';

/**
 * Global so any data write path (REST v1, table editor, collections) can
 * inject RealtimeDataService without module import cycles.
 */
@Global()
@Module({
  controllers: [
    RealtimeDataStreamController,
    RealtimeBindingsController,
    RealtimeApiController,
  ],
  providers: [
    RealtimeDataService,
    RealtimeFanoutService,
    RealtimePolicyService,
    RealtimePresenceService,
    RealtimeBroadcastService,
    QueryAccessTokenGuard,
  ],
  exports: [RealtimeDataService],
})
export class RealtimeDataModule {}
