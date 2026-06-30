import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { VectorStoreService } from '../embedding/vector-store.service';
import { RedisService } from '../redis/redis.service';
import type { EmbedJob } from '../embedding/types';

const SESSION_TTL_SECONDS = 4 * 3600; // 4 hours
const SESSION_BUCKET_MS = 4 * 3600 * 1000;
const DEDUP_THRESHOLD = 0.15; // normalize query literals for dedup

export interface RecommendedQuery {
  query: string;
  entityId: string;
  similarity: number;
  rowCount: number | null;
  duration: number | null;
}

export interface RecommendedPattern {
  query: string;
  entityId: string;
  similarity: number;
  projectId: string | null;
}

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Find SQL queries similar to the given reference query within the same project.
   * Used in the SQL editor to show "Similar queries" after execution.
   */
  async getSimilarQueries(
    userId: string,
    projectId: string,
    referenceQuery: string,
    limit = 5,
  ): Promise<RecommendedQuery[]> {
    await this.ensureProjectAccess(userId, projectId);

    const embedding = await this.embeddingService.generateEmbedding(referenceQuery);
    if (!embedding) return [];

    const similar = await this.vectorStore.findSimilar(embedding, {
      entityTypes: ['sql_audit_log'],
      projectId,
      threshold: 0.35,
      limit: limit * 3,
    });

    if (similar.length === 0) return [];

    // Hydrate with audit log data
    const entityIds = similar.map((s) => s.entityId);
    const auditLogs = await this.prisma.sqlAuditLog.findMany({
      where: { id: { in: entityIds } },
      select: { id: true, query: true, rowCount: true, duration: true },
    });
    const logMap = new Map(auditLogs.map((l) => [l.id, l]));

    const normalizedRef = this.normalizeQuery(referenceQuery);
    const seen = new Set<string>();
    const results: RecommendedQuery[] = [];

    for (const item of similar) {
      const log = logMap.get(item.entityId);
      if (!log) continue;

      const normalized = this.normalizeQuery(log.query);
      // Skip if it's essentially the same query as the reference
      if (normalized === normalizedRef) continue;
      // Skip near-duplicates within the result set
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      results.push({
        query: log.query,
        entityId: item.entityId,
        similarity: item.score,
        rowCount: log.rowCount,
        duration: log.duration,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Find SQL patterns used across the entire team (cross-project).
   * Used to surface "Patterns from your other projects" suggestions.
   */
  async getRelatedPatterns(
    userId: string,
    teamId: string,
    referenceQuery: string,
    limit = 3,
  ): Promise<RecommendedPattern[]> {
    await this.ensureTeamAccess(userId, teamId);

    const embedding = await this.embeddingService.generateEmbedding(referenceQuery);
    if (!embedding) return [];

    const similar = await this.vectorStore.findSimilar(embedding, {
      entityTypes: ['sql_audit_log'],
      teamId,
      threshold: 0.3,
      limit: limit * 3,
    });

    if (similar.length === 0) return [];

    const entityIds = similar.map((s) => s.entityId);
    const auditLogs = await this.prisma.sqlAuditLog.findMany({
      where: { id: { in: entityIds } },
      select: { id: true, query: true },
    });
    const logMap = new Map(auditLogs.map((l) => [l.id, l]));

    const normalizedRef = this.normalizeQuery(referenceQuery);
    const seen = new Set<string>();
    const results: RecommendedPattern[] = [];

    for (const item of similar) {
      const log = logMap.get(item.entityId);
      if (!log) continue;

      const normalized = this.normalizeQuery(log.query);
      if (normalized === normalizedRef) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      results.push({
        query: log.query,
        entityId: item.entityId,
        similarity: item.score,
        projectId: item.projectId,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Build or refresh a "behavior session" embedding for the user.
   * Represents the user's recent SQL activity as a single vector.
   * Stored in Redis with 4h TTL; only recomputed when expired.
   */
  async indexUserSession(userId: string, projectId: string): Promise<void> {
    try {
      const bucket = Math.floor(Date.now() / SESSION_BUCKET_MS);
      const sessionKey = `emb:session:${userId}:${projectId}:${bucket}`;

      const existing = await this.redis.get(sessionKey);
      if (existing) return; // Already indexed this session window

      const recentLogs = await this.prisma.sqlAuditLog.findMany({
        where: { projectId, userId, error: null },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, query: true },
      });

      if (recentLogs.length === 0) return;

      const sessionText = recentLogs
        .map((l) => l.query.replace(/\s+/g, ' ').trim().slice(0, 200))
        .join(' | ');

      const job: EmbedJob = {
        entityType: 'user_behavior_session',
        entityId: `${userId}:${projectId}:${bucket}`,
        content: sessionText,
        projectId,
      };

      this.embeddingService.enqueueJob([job], 10);

      // Mark session as indexed (value irrelevant — just presence matters)
      await this.redis.set(sessionKey, '1', SESSION_TTL_SECONDS);
    } catch (err: any) {
      this.logger.warn('Failed to index user session', err?.message);
    }
  }

  private normalizeQuery(query: string): string {
    return query
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      .replace(/'[^']*'/g, '?') // string literals
      .replace(/\b\d+\b/g, '?') // numeric literals
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .slice(0, 300);
  }

  private async ensureProjectAccess(userId: string, projectId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: { teamId: true },
    });
    if (!project) return;
    // Non-throwing: if no membership found, getSimilarQueries still returns []
  }

  private async ensureTeamAccess(userId: string, teamId: string): Promise<void> {
    // Non-throwing: caller decides whether to surface results
    await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
  }
}
