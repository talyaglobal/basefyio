import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { FlowsController } from './flows.controller';
import { FlowsService } from './flows.service';
import { FlowExecuteProcessor } from './flow-execute.processor';
import { FlowSchedulerService } from './flow-scheduler.service';

@Module({
  imports: [PrismaModule, ProjectsModule],
  controllers: [FlowsController],
  providers: [FlowsService, FlowExecuteProcessor, FlowSchedulerService],
  exports: [FlowsService],
})
export class FlowsModule {}
