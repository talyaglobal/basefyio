import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { FlowsController } from './flows.controller';
import { FlowWebhookController } from './flow-webhook.controller';
import { FlowsService } from './flows.service';
import { FlowExecuteProcessor } from './flow-execute.processor';
import { FlowSchedulerService } from './flow-scheduler.service';
import { FlowConcurrencyService } from './flow-concurrency';

@Module({
  imports: [PrismaModule, ProjectsModule],
  controllers: [FlowsController, FlowWebhookController],
  providers: [FlowsService, FlowExecuteProcessor, FlowSchedulerService, FlowConcurrencyService],
  exports: [FlowsService],
})
export class FlowsModule {}
