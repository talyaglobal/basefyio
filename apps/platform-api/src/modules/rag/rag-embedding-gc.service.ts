import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RAG_CHUNK_ENTITY_TYPE } from './rag.constants';

export interface OrphanEmbedding {
  /** embedding_records.id */
  recordId: string;
  /** embedding_records.entity_id — the rag_chunks.id that no longer exists */
  chunkId: string;
}

export interface GcSweepResult {
  orphans: number;
  deleted: number;
  dryRun: boolean;
  /** First N orphans, for logging/inspection. */
  sample: OrphanEmbedding[];
}

const DELETE_BATCH = 500;

/**
 * Orphan embedding cleanup sweep (commit 3 / cleanup debt from the indexer).
 *
 * The indexer embeds each chunk BEFORE the chunk-swap transaction. If that
 * transaction fails, embeddings_store / embedding_records keep vectors for chunk
 * ids that were never inserted. Reindexing also leaves the previous chunks'
 * embedding records behind once their rag_chunks rows are replaced. Both show up
 * as embedding_records of entity_type `rag_document_chunk` whose entity_id has no
 * matching rag_chunks.id.
 *
 * Deletion goes through Prisma's embedding_records (the existing path); the
 * vector in embeddings_store is removed by the ON DELETE CASCADE FK.
 */
@Injectable()
export class RagEmbeddingGcService {
  private readonly logger = new Logger(RagEmbeddingGcService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find embedding records for RAG chunks that no longer exist in rag_chunks.
   * Optionally scoped to one project. Read-only.
   */
  async findOrphans(
    opts: { projectId?: string; limit?: number } = {},
  ): Promise<OrphanEmbedding[]> {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 50_000);
    const params: unknown[] = [RAG_CHUNK_ENTITY_TYPE];
    let projectFilter = '';
    if (opts.projectId) {
      params.push(opts.projectId);
      projectFilter = `AND er.project_id = $${params.length}`;
    }
    params.push(limit);
    const limitPlaceholder = `$${params.length}`;

    const sql = `
      SELECT er.id AS record_id, er.entity_id AS chunk_id
      FROM embedding_records er
      LEFT JOIN rag_chunks rc ON rc.id = er.entity_id
      WHERE er.entity_type = $1
        AND rc.id IS NULL
        ${projectFilter}
      LIMIT ${limitPlaceholder}
    `;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ record_id: string; chunk_id: string }>
    >(sql, ...params);
    return rows.map((r) => ({ recordId: r.record_id, chunkId: r.chunk_id }));
  }

  /**
   * Sweep orphans. With `dryRun: true` nothing is deleted — the orphans are only
   * counted and sampled. Otherwise orphaned embedding_records are deleted in
   * batches (embeddings_store rows cascade away via FK).
   */
  async sweep(
    opts: { projectId?: string; dryRun?: boolean; limit?: number } = {},
  ): Promise<GcSweepResult> {
    const orphans = await this.findOrphans(opts);
    const sample = orphans.slice(0, 20);

    if (opts.dryRun) {
      this.logger.log(
        `[dry-run] ${orphans.length} orphaned RAG embedding record(s) found`,
      );
      return { orphans: orphans.length, deleted: 0, dryRun: true, sample };
    }

    let deleted = 0;
    const chunkIds = orphans.map((o) => o.chunkId);
    for (let i = 0; i < chunkIds.length; i += DELETE_BATCH) {
      const batch = chunkIds.slice(i, i + DELETE_BATCH);
      const res = await this.prisma.embeddingRecord.deleteMany({
        where: { entityType: RAG_CHUNK_ENTITY_TYPE, entityId: { in: batch } },
      });
      deleted += res.count;
    }

    this.logger.log(
      `Deleted ${deleted} orphaned RAG embedding record(s)` +
        (opts.projectId ? ` for project ${opts.projectId}` : ''),
    );
    return { orphans: orphans.length, deleted, dryRun: false, sample };
  }
}
