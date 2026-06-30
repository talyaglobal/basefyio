import { Module } from '@nestjs/common';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { AuthModule } from '../auth/auth.module';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';
import { ObservabilityModule } from '../observability/observability.module';

@Module({
  imports: [AuthModule, ObservabilityModule],
  controllers: [TeamsController],
  providers: [TeamsService, RealtimeEventsService, RealtimeStreamService],
  exports: [TeamsService],
})
export class TeamsModule {}
