import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FlowsController } from './flows.controller';
import { FlowsService } from './flows.service';
import { FlowExecuteProcessor } from './flow-execute.processor';
import { FLOW_QUEUE } from '../queue/queue.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [BullModule.registerQueue({ name: FLOW_QUEUE }), AgentModule],
  controllers: [FlowsController],
  providers: [FlowsService, FlowExecuteProcessor],
  exports: [FlowsService],
})
export class FlowsModule {}
