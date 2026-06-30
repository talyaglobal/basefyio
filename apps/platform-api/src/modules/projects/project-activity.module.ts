import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectActivityService } from './project-activity.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';

@Module({
  imports: [PrismaModule],
  providers: [ProjectActivityService, RealtimeEventsService, RealtimeStreamService],
  exports: [ProjectActivityService, RealtimeEventsService],
})
export class ProjectActivityModule {}
