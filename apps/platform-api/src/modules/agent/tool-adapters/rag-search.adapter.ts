import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../../../db/drizzle/drizzle.module';
import type { DrizzleDb } from '../../../db/drizzle/client';
import { ragChunks, ragDocuments } from '../../../db/drizzle/schema/rag';
import type { CitationResult } from '../../../db/drizzle/schema/agent-attachments';
import { EmbeddingService } from '../../embedding/embedding.service';
import { VectorStoreService } from '../../embedding/vector-store.service';
import { RAG_CHUNK_ENTITY_TYPE } from '../../rag/rag.constants';
import type {
  ToolAdapter,
  ToolAdapterContext,
  ToolAdapterResult,
} from './tool-adapter.interface';

const DEFAULT_LIMIT = 8;
const DEFAULT_THRESHOLD = 0.45;
const MAX_LIMIT = 20;

@Injectable()
export class RagSearchAdapter implements ToolAdapter {
  readonly toolId = 'rag_search';
  private readonly logger = new Logger(RagSearchAdapter.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly embedding: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolAdapterContext,
  ): Promise<ToolAdapterResult> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) {
      return { output: { results: [], error: 'query is required' } };
    }

    const limit = Math.min(
      typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const threshold =
      typeof input.threshold === 'number' ? input.threshold : DEFAULT_THRESHOLD;

    const vector = await this.embedding.generateEmbedding(query);
    if (!vector) {
      this.logger.warn(`rag_search: embedding returned null for run ${ctx.runId}`);
      return { output: { results: [] } };
    }

    const hits = await this.vectorStore.findSimilar(vector, {
      entityTypes: [RAG_CHUNK_ENTITY_TYPE],
      projectId: ctx.projectId,
      threshold,
      limit,
    });

    if (!hits.length) {
      return { output: { results: [] } };
    }

    // Hydrate hits against rag_chunks + rag_documents (project-scoped).
    const chunkIds = hits.map((h) => h.entityId).filter(Boolean) as string[];

    const rows = await this.db
      .select({
        chunkId: ragChunks.id,
        chunkIndex: ragChunks.chunkIndex,
        content: ragChunks.content,
        documentId: ragChunks.documentId,
        title: ragDocuments.title,
        bucketName: ragDocuments.bucketName,
        objectKey: ragDocuments.objectKey,
      })
      .from(ragChunks)
      .innerJoin(ragDocuments, eq(ragChunks.documentId, ragDocuments.id))
      .where(
        and(
          inArray(ragChunks.id, chunkIds),
          eq(ragChunks.projectId, ctx.projectId),
        ),
      );

    const rowMap = new Map(rows.map((r) => [r.chunkId, r]));

    const citations: CitationResult[] = hits
      .map((hit) => {
        const row = rowMap.get(hit.entityId);
        return {
          documentId: row?.documentId ?? null,
          chunkId: hit.entityId,
          chunkIndex: row?.chunkIndex ?? null,
          title: row?.title ?? null,
          score: hit.score,
          text: row?.content ?? null,
          bucketName: row?.bucketName ?? null,
          objectKey: row?.objectKey ?? null,
        } satisfies CitationResult;
      });

    return {
      output: {
        results: citations.map((c) => ({
          title: c.title,
          text: c.text,
          score: c.score,
          documentId: c.documentId,
        })),
      },
      citations,
      attachments: [
        {
          kind: 'rag_citation',
          content: { citations } as unknown as Record<string, unknown>,
        },
      ],
    };
  }
}
