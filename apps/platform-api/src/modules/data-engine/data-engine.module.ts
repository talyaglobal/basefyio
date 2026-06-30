import { Global, Module } from '@nestjs/common';
import { DataEngineService } from './data-engine.service';
import { DataEngineController } from './data-engine.controller';

@Global()
@Module({
  providers: [DataEngineService],
  controllers: [DataEngineController],
  exports: [DataEngineService],
})
export class DataEngineModule {}
