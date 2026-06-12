import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { BlueprintController } from './blueprint.controller';
import { BlueprintService } from './blueprint.service';
import { BlueprintGenerateProcessor } from './blueprint-generate.processor';
import { BLUEPRINT_GENERATE_QUEUE } from '../queue/queue.module';

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({ name: BLUEPRINT_GENERATE_QUEUE }),
  ],
  controllers: [BlueprintController],
  providers: [BlueprintService, BlueprintGenerateProcessor],
  exports: [BlueprintService],
})
export class BlueprintModule {}
