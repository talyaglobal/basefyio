import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle/drizzle.module';
import { Inject } from '@nestjs/common';
import type { DrizzleDb } from '../../db/drizzle/client';
import { agentTools } from '../../db/drizzle/schema/agent-creation';
import { AgentRepository } from './agent.repository';

export interface PolicyContext {
  projectId: string;
  agentId: string;
  runId?: string | null;
  threadId?: string | null;
  /** Whether the project/run has explicitly opted in to mutating tools. */
  allowMutating?: boolean;
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; reasonCode: string };

/**
 * Policy gateway — default-deny for all agent tool calls.
 *
 * Rules (evaluated in order; first failure wins):
 *  1. Tool must be registered in agent_tools.
 *  2. Tool must be enabled.
 *  3. Mutating tools require explicit opt-in (allowMutating flag).
 *  4. High-risk tools are denied in draft agents (not yet: agent status check
 *     lives in AgentCreationService.runAgent — noted for the runner commit).
 *
 * Every decision is returned as a typed value; callers record it via
 * AgentRepository.recordPolicyEvent. This service does NOT record — the caller
 * controls the transaction boundary.
 */
@Injectable()
export class PolicyGatewayService {
  private readonly logger = new Logger(PolicyGatewayService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async evaluate(
    toolId: string,
    ctx: PolicyContext,
  ): Promise<PolicyDecision> {
    const rows = await this.db
      .select()
      .from(agentTools)
      .where(eq(agentTools.toolId, toolId))
      .limit(1);

    const tool = rows[0];

    if (!tool) {
      return {
        allowed: false,
        reason: `Tool "${toolId}" is not registered`,
        reasonCode: 'TOOL_NOT_REGISTERED',
      };
    }

    if (!tool.enabled) {
      return {
        allowed: false,
        reason: `Tool "${toolId}" is disabled`,
        reasonCode: 'TOOL_DISABLED',
      };
    }

    if (tool.mutating && !ctx.allowMutating) {
      return {
        allowed: false,
        reason: `Mutating tool "${toolId}" requires explicit opt-in`,
        reasonCode: 'MUTATING_TOOL_NOT_ALLOWED',
      };
    }

    return { allowed: true };
  }
}
