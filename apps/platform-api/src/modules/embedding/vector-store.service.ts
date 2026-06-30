import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { EntityType, FindSimilarOptions, SimilarityResult } from './types';

/** Serialize a JS number[] to the `[x,y,...]` format PostgreSQL vector cast expects. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

@Injectable()
export class VectorStoreService {
  private readonly logger = new Logger(VectorStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert or update a vector in embeddings_store.
   * Uses ON CONFLICT so calling this twice for the same id is safe.
   */
  async upsertVector(recordId: string, embedding: number[]): Promise<void> {
    const literal = toVectorLiteral(embedding);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO embeddings_store (id, embedding)
       VALUES ($1, $2::vector)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      recordId,
      literal,
    );
  }

  /**
   * Approximate nearest-neighbor search using HNSW cosine distance.
   *
   * Returns results sorted by ascending distance (most similar first).
   * The query embedding is expected as a plain JS number[].
   */
  async findSimilar(
    queryEmbedding: number[],
    opts: FindSimilarOptions = {},
  ): Promise<SimilarityResult[]> {
    const {
      entityTypes,
      projectId,
      teamId,
      threshold = 0.5,
      limit = 10,
    } = opts;

    const literal = toVectorLiteral(queryEmbedding);

    // Build the WHERE clause dynamically. We use numbered placeholders
    // compatible with Prisma's $queryRawUnsafe (positional $N syntax).
    // $1 = vector literal, remaining slots for optional filters.
    const conditions: string[] = [`(es.embedding <=> $1::vector) < $2`];
    const params: unknown[] = [literal, threshold];

    if (entityTypes && entityTypes.length > 0) {
      params.push(entityTypes);
      conditions.push(`er.entity_type = ANY($${params.length}::text[])`);
    }

    if (projectId) {
      params.push(projectId);
      conditions.push(`er.project_id = $${params.length}`);
    }

    if (teamId) {
      params.push(teamId);
      conditions.push(`er.team_id = $${params.length}`);
    }

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;

    const sql = `
      SELECT
        er.entity_type,
        er.entity_id,
        er.project_id,
        er.team_id,
        er.metadata,
        (es.embedding <=> $1::vector) AS distance
      FROM embeddings_store es
      JOIN embedding_records er ON er.id = es.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY es.embedding <=> $1::vector
      LIMIT ${limitPlaceholder}
    `;

    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{
          entity_type: string;
          entity_id: string;
          project_id: string | null;
          team_id: string | null;
          metadata: Record<string, unknown> | null;
          distance: number;
        }>
      >(sql, ...params);

      return rows.map((r) => ({
        entityType: r.entity_type as EntityType,
        entityId: r.entity_id,
        projectId: r.project_id,
        teamId: r.team_id,
        distance: Number(r.distance),
        score: 1 - Number(r.distance),
        text: (r.metadata as any)?.text ?? null,
        meta: r.metadata,
      }));
    } catch (err: any) {
      this.logger.error('findSimilar query failed', err?.message);
      return [];
    }
  }

  /**
   * Delete all embeddings for a given entity (both metadata and vector rows).
   * Cascades automatically via FK — deleting from embedding_records is enough.
   */
  async deleteByEntity(entityType: EntityType, entityId: string): Promise<void> {
    await this.prisma.embeddingRecord.deleteMany({
      where: { entityType, entityId },
    });
  }

  /**
   * Delete all embeddings scoped to a project.
   * Called when a project is permanently deleted.
   */
  async deleteByProject(projectId: string): Promise<void> {
    await this.prisma.embeddingRecord.deleteMany({ where: { projectId } });
  }
}
