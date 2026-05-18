import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMBEDDING_QUEUE } from '../queue/queue.module';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';
import { EmbeddingProcessor } from './embedding.processor';
import { SchemaIndexerService } from './schema-indexer.service';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: EMBEDDING_QUEUE })],
  providers: [EmbeddingService, VectorStoreService, EmbeddingProcessor, SchemaIndexerService],
  exports: [EmbeddingService, VectorStoreService, SchemaIndexerService],
})
export class EmbeddingModule {}
