import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DATA_VECTOR_QUEUE } from '../queue/queue.module';
import { DataEngineService } from './data-engine.service';
import { DataEngineController } from './data-engine.controller';
import { DataVectorController } from './data-vector.controller';
import { DataVectorEmbedderService } from './data-vector-embedder.service';
import { DataVectorProcessor } from './data-vector.processor';

/**
 * EmbeddingModule is @Global(), so ProjectEmbeddingService is injected
 * without an explicit import. DataVectorProcessor consumes DATA_VECTOR_QUEUE
 * (platform vectors of Data Engine records).
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: DATA_VECTOR_QUEUE })],
  providers: [DataEngineService, DataVectorEmbedderService, DataVectorProcessor],
  controllers: [DataEngineController, DataVectorController],
  exports: [DataEngineService, DataVectorEmbedderService],
})
export class DataEngineModule {}
