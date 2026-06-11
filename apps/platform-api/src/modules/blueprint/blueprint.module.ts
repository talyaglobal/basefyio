import { Module } from '@nestjs/common';
import { BlueprintController } from './blueprint.controller';
import { BlueprintService } from './blueprint.service';

@Module({
  controllers: [BlueprintController],
  providers: [BlueprintService],
  exports: [BlueprintService],
})
export class BlueprintModule {}
