import { Module } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { StorageModule } from '../storage/storage.module';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';

@Module({
  imports: [StorageModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, RootRoleGuard, RealtimeEventsService, RealtimeStreamService],
})
export class FeedbackModule {}
