import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import type { AnalyzedStatement } from './ai-sql';
import type { DryRunResult } from './ai-database.service';

/** How long a proposal can wait for approval. */
export const PROPOSAL_TTL_SECONDS = 60 * 60;

export interface AiProposal {
  id: string;
  userId: string;
  projectId: string;
  /** The script exactly as it will run, statement by statement. */
  statements: Pick<AnalyzedStatement, 'sql' | 'kind' | 'command' | 'destructive' | 'warning'>[];
  validation: DryRunResult | null;
  createdAt: string;
  expiresAt: string;
}

/** What the dashboard sees of a proposal (no owner id). */
export type AiProposalView = Omit<AiProposal, 'userId'>;

/**
 * Changes the assistant wants to make, waiting for a person to approve them.
 *
 * This is where "the assistant cannot change your database on its own" is
 * enforced: the assistant can only create a proposal. Running one takes a
 * separate request from the signed-in person who owns it, naming its id, and
 * the SQL that runs is the SQL stored here — not anything the request carries.
 * A proposal is taken atomically (GETDEL), so it runs at most once.
 */
@Injectable()
export class AiProposalsService {
  constructor(private readonly redis: RedisService) {}

  private key(id: string) {
    return `ai:proposal:${id}`;
  }

  async create(
    userId: string,
    projectId: string,
    statements: AiProposal['statements'],
    validation: DryRunResult | null,
  ): Promise<AiProposal> {
    const now = Date.now();
    const proposal: AiProposal = {
      id: randomUUID(),
      userId,
      projectId,
      statements: statements.map(({ sql, kind, command, destructive, warning }) => ({
        sql,
        kind,
        command,
        destructive,
        warning,
      })),
      validation,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PROPOSAL_TTL_SECONDS * 1000).toISOString(),
    };
    await this.redis.set(this.key(proposal.id), JSON.stringify(proposal), PROPOSAL_TTL_SECONDS);
    return proposal;
  }

  /**
   * Remove and return a proposal for its owner. Someone else's proposal reads
   * as missing (and is put back untouched), so ids cannot be probed.
   */
  async take(id: string, userId: string): Promise<AiProposal> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Proposal not found');
    const raw = await this.redis.getdel(this.key(id));
    if (!raw) {
      throw new GoneException('This change is no longer available (it expired or was already handled). Ask the assistant again.');
    }
    const proposal = JSON.parse(raw) as AiProposal;
    if (proposal.userId !== userId) {
      const ttl = Math.max(1, Math.floor((Date.parse(proposal.expiresAt) - Date.now()) / 1000));
      await this.redis.set(this.key(id), raw, ttl);
      throw new NotFoundException('Proposal not found');
    }
    return proposal;
  }

  /** Put a taken proposal back, when it could not run for a reason outside the SQL (connection lost). */
  async restore(proposal: AiProposal): Promise<void> {
    const ttl = Math.floor((Date.parse(proposal.expiresAt) - Date.now()) / 1000);
    if (ttl > 0) await this.redis.set(this.key(proposal.id), JSON.stringify(proposal), ttl);
  }

  static view(p: AiProposal): AiProposalView {
    const { userId: _owner, ...rest } = p;
    return rest;
  }
}
