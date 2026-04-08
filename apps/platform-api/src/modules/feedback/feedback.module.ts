import { Module } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { StorageModule } from '../storage/storage.module';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';

@Module({
  imports: [StorageModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, RootRoleGuard, RealtimeEventsService],
})
export class FeedbackModule {}
