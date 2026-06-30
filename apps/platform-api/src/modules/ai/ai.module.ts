import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { RagService } from './rag.service';

@Module({
  controllers: [AiController],
  // EmbeddingModule is @Global() so EmbeddingService and VectorStoreService
  // are available without an explicit import here.
  providers: [AiService, RagService],
})
export class AiModule {}
