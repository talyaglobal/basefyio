import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { DrizzleModule } from '../../db/drizzle/drizzle.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentRepository } from './agent.repository';

/**
 * Agentic Storage module (Module 2 — Phase A).
 *
 * Owns the conversation layer: chat_threads, chat_messages, agent_memory,
 * agent_tool_calls, agent_policy_events. All tables are project-scoped with
 * tenant isolation enforced in the service layer.
 *
 * AgentRepository and AgentService are exported so Module 3 (Agent Creation)
 * can reuse them for tool-call recording and policy event logging without
 * importing the full module.
 */
@Module({
  imports: [PrismaModule, DrizzleModule, ProjectActivityModule],
  controllers: [AgentController],
  providers: [AgentService, AgentRepository],
  exports: [AgentService, AgentRepository],
})
export class AgentModule {}
