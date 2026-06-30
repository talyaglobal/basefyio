import { Module } from '@nestjs/common';
import { TenantEmbeddingService } from './tenant-embedding.service';
import { TenantEmbeddingController } from './tenant-embedding.controller';
import { TenantEmbeddingPublicController } from './tenant-embedding-public.controller';

@Module({
  controllers: [TenantEmbeddingController, TenantEmbeddingPublicController],
  providers: [TenantEmbeddingService],
  exports: [TenantEmbeddingService],
})
export class TenantEmbeddingModule {}
