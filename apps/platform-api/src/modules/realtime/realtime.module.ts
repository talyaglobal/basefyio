import { Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';

@Module({
  controllers: [RealtimeController],
  providers: [RealtimeStreamService],
  exports: [RealtimeStreamService],
})
export class RealtimeModule {}

