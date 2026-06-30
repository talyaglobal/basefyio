import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { FlowsController } from './flows.controller';
import { FlowsService } from './flows.service';
import { FlowExecuteProcessor } from './flow-execute.processor';

@Module({
  imports: [PrismaModule, ProjectsModule],
  controllers: [FlowsController],
  providers: [FlowsService, FlowExecuteProcessor],
  exports: [FlowsService],
})
export class FlowsModule {}
