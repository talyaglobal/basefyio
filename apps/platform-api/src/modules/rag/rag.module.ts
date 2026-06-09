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

/**
 * RAG storage module (commit 1: skeleton).
 *
 * EmbeddingModule is @Global(), so EmbeddingService and VectorStoreService are
 * injected without an explicit import. The chunk→embed→store worker (a BullMQ
 * processor on RAG_INDEX_QUEUE) is added in commit 2.
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
  providers: [RagService, RagRepository],
  exports: [RagService],
})
export class RagModule {}
