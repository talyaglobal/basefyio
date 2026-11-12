import { Module } from '@nestjs/common';
import { AiController, AiSettingsController } from './ai.controller';
import { AiService } from './ai.service';
import { RagService } from './rag.service';
import { AiDatabaseService } from './ai-database.service';
import { AiProposalsService } from './ai-proposals.service';
import { AiSettingsService } from './ai-settings.service';
import { ProjectActivityModule } from '../projects/project-activity.module';

@Module({
  imports: [ProjectActivityModule],
  controllers: [AiController, AiSettingsController],
  // EmbeddingModule is @Global() so EmbeddingService and VectorStoreService
  // are available without an explicit import here; so are Prisma and Redis.
  providers: [AiService, RagService, AiDatabaseService, AiProposalsService, AiSettingsService],
})
export class AiModule {}
