import { Global, Module } from '@nestjs/common';
import { RealtimeDataService } from './realtime-data.service';
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
  providers: [RealtimeDataService],
  exports: [RealtimeDataService],
})
export class RealtimeDataModule {}
