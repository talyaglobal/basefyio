import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectActivityService } from './project-activity.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';

@Module({
  imports: [PrismaModule],
  providers: [ProjectActivityService, RealtimeEventsService],
  exports: [ProjectActivityService],
})
export class ProjectActivityModule {}
