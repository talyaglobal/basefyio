import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RagEmbeddingGcService } from './rag-embedding-gc.service';

/**
 * RAG embedding garbage-collection (commit 3). Kept in its own module so the
 * cleanup sweep is independent of the RAG request/worker path in RagModule.
 * Exposes no HTTP routes — the sweep runs via the `rag:gc` script or a scheduled
 * job that injects RagEmbeddingGcService.
 */
@Module({
  imports: [PrismaModule],
  providers: [RagEmbeddingGcService],
  exports: [RagEmbeddingGcService],
})
export class RagGcModule {}
