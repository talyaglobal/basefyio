import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { DrizzleModule } from '../../db/drizzle/drizzle.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentRepository } from './agent.repository';
import { AgentCreationController } from './agent-creation.controller';
import { AgentCreationService } from './agent-creation.service';
import { AgentCreationRepository } from './agent-creation.repository';
import { PolicyGatewayService } from './policy-gateway.service';
import { AgentRunnerService } from './agent-runner.service';

/**
 * Agent module — Module 2 (Agentic Storage) + Module 3 (Agent Creation).
 *
 * Module 2: chat_threads, chat_messages, agent_memory, agent_tool_calls,
 *           agent_policy_events — conversation + memory layer.
 * Module 3: agents, agent_versions, agent_tools, agent_runs — entity +
 *           versioning + policy gateway. Runner execution is in commit 2.
 *
 * PolicyGatewayService is exported so the future runner (commit 2) can
 * evaluate tool calls without re-importing the full module.
 */
@Module({
  imports: [PrismaModule, DrizzleModule, ProjectActivityModule],
  controllers: [AgentController, AgentCreationController],
  providers: [
    AgentService,
    AgentRepository,
    AgentCreationService,
    AgentCreationRepository,
    PolicyGatewayService,
    AgentRunnerService,
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
