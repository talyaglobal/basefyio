import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectActivityService } from './project-activity.service';

@Module({
  imports: [PrismaModule],
  providers: [ProjectActivityService],
  exports: [ProjectActivityService],
})
export class ProjectActivityModule {}
