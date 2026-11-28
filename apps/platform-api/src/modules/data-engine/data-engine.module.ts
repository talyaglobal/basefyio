import { Global, Module } from '@nestjs/common';
import { DataEngineService } from './data-engine.service';
import { DataEngineController } from './data-engine.controller';
import { DataVectorController } from './data-vector.controller';

@Global()
@Module({
  providers: [DataEngineService],
  controllers: [DataEngineController, DataVectorController],
  exports: [DataEngineService],
})
export class DataEngineModule {}
