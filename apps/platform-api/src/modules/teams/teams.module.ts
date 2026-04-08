import { Module } from '@nestjs/common';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { ObservabilityModule } from '../observability/observability.module';

@Module({
  imports: [AuthModule, BillingModule, ObservabilityModule],
  controllers: [TeamsController],
  providers: [TeamsService, RealtimeEventsService],
  exports: [TeamsService],
})
export class TeamsModule {}
