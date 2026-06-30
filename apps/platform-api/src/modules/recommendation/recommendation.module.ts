import { Module } from '@nestjs/common';
import { RecommendationController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';

@Module({
  controllers: [RecommendationController],
  // EmbeddingModule is @Global() — EmbeddingService, VectorStoreService,
  // and RedisModule providers are available without explicit imports.
  providers: [RecommendationService],
  exports: [RecommendationService],
})
export class RecommendationModule {}
