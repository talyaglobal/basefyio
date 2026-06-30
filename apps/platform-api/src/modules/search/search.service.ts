import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { VectorStoreService } from '../embedding/vector-store.service';
import type { EntityType, SimilarityResult } from '../embedding/types';
import type { SearchResult } from './dto/search.dto';

const RRF_K = 60; // Reciprocal Rank Fusion constant — standard value

interface TrgmRow {
  entity_type: string;
  entity_id: string;
  project_id: string | null;
  team_id: string | null;
  trgm_score: number;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
  ) {}

  async search(opts: {
    userId: string;
    query: string;
    projectId?: string;
    teamId?: string;
    entityTypes?: EntityType[];
    limit?: number;
  }): Promise<SearchResult[]> {
    const { userId, query, projectId, entityTypes, limit = 20 } = opts;

    // Resolve teamId from user's active team if not provided
    const teamId = opts.teamId ?? (await this.resolveTeamId(userId, projectId));

    // Run semantic search and keyword search in parallel
    const [semanticResults, keywordResults] = await Promise.all([
      this.semanticSearch(query, { projectId, teamId, entityTypes, limit: limit * 2 }),
      this.keywordSearch(query, { projectId, teamId, entityTypes, limit: limit * 2 }),
    ]);

    // Merge with Reciprocal Rank Fusion
    const merged = this.reciprocalRankFusion(semanticResults, keywordResults);

    return merged.slice(0, limit);
  }

  private async semanticSearch(
    query: string,
    opts: {
      projectId?: string;
      teamId?: string;
      entityTypes?: EntityType[];
      limit: number;
    },
  ): Promise<SimilarityResult[]> {
    const embedding = await this.embeddingService.generateEmbedding(query);
    if (!embedding) return [];

    return this.vectorStore.findSimilar(embedding, {
      entityTypes: opts.entityTypes,
      projectId: opts.projectId,
      teamId: opts.teamId,
      threshold: 0.6,
      limit: opts.limit,
    });
  }

  private async keywordSearch(
    query: string,
    opts: {
      projectId?: string;
      teamId?: string;
      entityTypes?: EntityType[];
      limit: number;
    },
  ): Promise<SimilarityResult[]> {
    if (!query || query.trim().length < 2) return [];

    try {
      // Scope filter: join with embedding_records to get entity metadata
      const conditions: string[] = ['similarity(er.entity_id, $1) > 0.05'];
      const params: unknown[] = [query];

      if (opts.entityTypes && opts.entityTypes.length > 0) {
        params.push(opts.entityTypes);
        conditions.push(`er.entity_type = ANY($${params.length}::text[])`);
      }
      if (opts.projectId) {
        params.push(opts.projectId);
        conditions.push(`er.project_id = $${params.length}`);
      }
      if (opts.teamId) {
        params.push(opts.teamId);
        conditions.push(`er.team_id = $${params.length}`);
      }

      params.push(opts.limit);

      // Use pg_trgm similarity on the stored text chunk (metadata->>'text')
      const sql = `
        SELECT
          er.entity_type,
          er.entity_id,
          er.project_id,
          er.team_id,
          er.metadata,
          GREATEST(
            similarity(COALESCE(er.metadata->>'text', ''), $1),
            similarity(er.entity_id, $1)
          ) AS trgm_score
        FROM embedding_records er
        WHERE
          ${conditions.join(' AND ')}
          AND GREATEST(
            similarity(COALESCE(er.metadata->>'text', ''), $1),
            similarity(er.entity_id, $1)
          ) > 0.05
        ORDER BY trgm_score DESC
        LIMIT $${params.length}
      `;

      const rows = await this.prisma.$queryRawUnsafe<
        Array<TrgmRow & { metadata: Record<string, unknown> | null }>
      >(sql, ...params);

      return rows.map((r) => ({
        entityType: r.entity_type as EntityType,
        entityId: r.entity_id,
        projectId: r.project_id,
        teamId: r.team_id,
        distance: 1 - Number(r.trgm_score),
        score: Number(r.trgm_score),
        text: (r.metadata as any)?.text ?? null,
        meta: r.metadata,
      }));
    } catch (err: any) {
      // pg_trgm may not be installed or threshold might be zero — graceful fallback
      this.logger.warn('Keyword search failed, falling back to semantic only', err?.message);
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion combines two ranked lists into one.
   * RRF(d) = Σ 1 / (k + rank_i(d)) for each list i containing d.
   */
  private reciprocalRankFusion(
    semanticList: SimilarityResult[],
    keywordList: SimilarityResult[],
  ): SearchResult[] {
    const scoreMap = new Map<
      string,
      { result: SimilarityResult; rrfScore: number }
    >();

    const addToMap = (list: SimilarityResult[], weight = 1) => {
      list.forEach((item, rank) => {
        const key = `${item.entityType}:${item.entityId}`;
        const rrfContrib = weight / (RRF_K + rank + 1);
        const existing = scoreMap.get(key);
        if (existing) {
          existing.rrfScore += rrfContrib;
        } else {
          scoreMap.set(key, { result: item, rrfScore: rrfContrib });
        }
      });
    };

    addToMap(semanticList, 1.0);
    addToMap(keywordList, 0.7); // slightly lower weight for keyword results

    return Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .map(({ result, rrfScore }) => ({
        entityType: result.entityType,
        entityId: result.entityId,
        projectId: result.projectId,
        teamId: result.teamId,
        score: rrfScore,
        text: result.text,
        meta: result.meta,
      }));
  }

  private async resolveTeamId(
    userId: string,
    projectId?: string,
  ): Promise<string | undefined> {
    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId },
        select: { teamId: true },
      });
      return project?.teamId;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeTeamId: true },
    });
    return user?.activeTeamId ?? undefined;
  }
}
