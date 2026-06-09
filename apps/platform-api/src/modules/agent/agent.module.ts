import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../../prisma/prisma.module';
import { DrizzleModule } from '../../db/drizzle/drizzle.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentRepository } from './agent.repository';
import { AgentCreationController } from './agent-creation.controller';
import { AgentCreationService } from './agent-creation.service';
import { AgentCreationRepository } from './agent-creation.repository';
import { PolicyGatewayService } from './policy-gateway.service';
import { AgentRunnerService } from './agent-runner.service';
import { RagSearchAdapter } from './tool-adapters/rag-search.adapter';
import { SqlExecutorAdapter } from './tool-adapters/sql-executor.adapter';
import { HttpCallerAdapter } from './tool-adapters/http-caller.adapter';
import { TOOL_ADAPTERS_TOKEN } from './tool-adapters/tool-adapter.interface';
import type { ToolAdapter } from './tool-adapters/tool-adapter.interface';

@Module({
  imports: [
    PrismaModule,
    DrizzleModule,
    ProjectActivityModule,
    EmbeddingModule,
    HttpModule,
  ],
  controllers: [AgentController, AgentCreationController],
  providers: [
    AgentService,
    AgentRepository,
    AgentCreationService,
    AgentCreationRepository,
    PolicyGatewayService,
    AgentRunnerService,
    RagSearchAdapter,
    SqlExecutorAdapter,
    HttpCallerAdapter,
    {
      provide: TOOL_ADAPTERS_TOKEN,
      useFactory: (
        rag: RagSearchAdapter,
        sql: SqlExecutorAdapter,
        http: HttpCallerAdapter,
      ): ToolAdapter[] => [rag, sql, http],
      inject: [RagSearchAdapter, SqlExecutorAdapter, HttpCallerAdapter],
    },
  ],
  exports: [
    AgentService,
    AgentRepository,
    AgentCreationService,
    AgentCreationRepository,
    PolicyGatewayService,
    AgentRunnerService,
  ],
})
export class AgentModule {}
