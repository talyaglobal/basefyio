import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TENANT_EMBEDDING_QUEUE } from '../queue/queue.module';
import { TenantEmbeddingService } from './tenant-embedding.service';
import { TenantEmbeddingController } from './tenant-embedding.controller';
import { TenantEmbeddingPublicController } from './tenant-embedding-public.controller';
import { AiDisclosureController } from './ai-disclosure.controller';
import { TenantReembedProcessor } from './tenant-reembed.processor';

/**
 * EmbeddingModule is @Global(), so EmbeddingProviderService is injected
 * without an explicit import. TenantReembedProcessor consumes
 * TENANT_EMBEDDING_QUEUE (in-place re-embedding after a provider switch).
 */
@Module({
  imports: [BullModule.registerQueue({ name: TENANT_EMBEDDING_QUEUE })],
  controllers: [
    TenantEmbeddingController,
    TenantEmbeddingPublicController,
    AiDisclosureController,
  ],
  providers: [TenantEmbeddingService, TenantReembedProcessor],
  exports: [TenantEmbeddingService],
})
export class TenantEmbeddingModule {}
