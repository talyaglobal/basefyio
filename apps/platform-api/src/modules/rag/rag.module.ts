import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../prisma/prisma.module';
import { DrizzleModule } from '../../db/drizzle/drizzle.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { RAG_INDEX_QUEUE } from '../queue/queue.module';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { RagRepository } from './rag.repository';
import { RagIndexerService } from './rag-indexer.service';
import { RagIndexProcessor } from './rag-index.processor';
import { RagEmbeddingGcService } from './rag-embedding-gc.service';

/**
 * RAG storage module — Module 1 (Phase A).
 *
 * EmbeddingModule is @Global(), so EmbeddingService and VectorStoreService are
 * injected without an explicit import. RagIndexProcessor consumes RAG_INDEX_QUEUE
 * (the "rag_embedding_job" worker) and delegates to RagIndexerService.
 * RagEmbeddingGcService sweeps orphaned embedding_records left by failed
 * chunk-upsert transactions; exported so an admin/cron endpoint can trigger it.
 */
@Module({
  imports: [
    PrismaModule,
    DrizzleModule,
    StorageModule,
    ProjectActivityModule,
    BullModule.registerQueue({ name: RAG_INDEX_QUEUE }),
  ],
  controllers: [RagController],
  providers: [
    RagService,
    RagRepository,
    RagIndexerService,
    RagIndexProcessor,
    RagEmbeddingGcService,
  ],
  exports: [RagService, RagEmbeddingGcService],
})
export class RagModule {}
