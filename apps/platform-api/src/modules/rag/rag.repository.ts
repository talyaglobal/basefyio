import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle/drizzle.module';
import type { DrizzleDb } from '../../db/drizzle/client';
import {
  ragDocuments,
  ragChunks,
  ragIndexJobs,
  type RagDocument,
  type RagIndexJob,
} from '../../db/drizzle/schema/rag';
import { RAG_INCOMPLETE_STATUSES, type RagDocStatus } from './rag-util';
import type { RagChunkRow } from './rag-chunk-builder';
import type { SimilarityResult } from '../embedding/types';

export interface CreateDocumentInput {
  projectId: string;
  bucketName: string;
  objectKey: string;
  title?: string | null;
  contentType?: string | null;
  sizeBytes?: number | bigint | null;
  granularity?: 'word' | 'sentence' | 'context';
  chunkSize?: number;
  chunkOverlap?: number;
  createdBy?: string | null;
}

export interface CreateIndexJobInput {
  projectId: string;
  documentId?: string | null;
  kind: 'INDEX' | 'REINDEX' | 'REINDEX_INCOMPLETE';
  dedupeKey: string;
}

export interface RagSearchResultItem {
  documentId: string | null;
  chunkIndex: number | null;
  title: string | null;
  score: number;
  distance: number;
  text: string | null;
  bucketName?: string | null;
  objectKey?: string | null;
}

/**
 * All Drizzle access for the RAG tables. Talks ONLY to the new tables; the
 * existing embedding pipeline (embeddings_store) is reached through
 * VectorStoreService/EmbeddingService, never directly from here.
 */
@Injectable()
export class RagRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Documents ──────────────────────────────────────────

  /**
   * Idempotent registration: relies on the UNIQUE(project_id, bucket_name,
   * object_key) invariant. A duplicate register returns the existing row with
   * `created: false` instead of inserting a second document.
   */
  async createDocumentFromBucketObject(
    input: CreateDocumentInput,
  ): Promise<{ document: RagDocument; created: boolean }> {
    const inserted = await this.db
      .insert(ragDocuments)
      .values({
        projectId: input.projectId,
        bucketName: input.bucketName,
        objectKey: input.objectKey,
        title: input.title ?? null,
        contentType: input.contentType ?? null,
        sizeBytes:
          input.sizeBytes != null ? BigInt(input.sizeBytes) : null,
        ...(input.granularity ? { granularity: input.granularity } : {}),
        ...(input.chunkSize != null ? { chunkSize: input.chunkSize } : {}),
        ...(input.chunkOverlap != null
          ? { chunkOverlap: input.chunkOverlap }
          : {}),
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoNothing({
        target: [
          ragDocuments.projectId,
          ragDocuments.bucketName,
          ragDocuments.objectKey,
        ],
      })
      .returning();

    if (inserted.length > 0) {
      return { document: inserted[0], created: true };
    }

    const existing = await this.db
      .select()
      .from(ragDocuments)
      .where(
        and(
          eq(ragDocuments.projectId, input.projectId),
          eq(ragDocuments.bucketName, input.bucketName),
          eq(ragDocuments.objectKey, input.objectKey),
        ),
      )
      .limit(1);

    if (!existing[0]) {
      throw new BadRequestException(
        'existing RAG document not found after insert conflict',
      );
    }
    return { document: existing[0], created: false };
  }

  /** Project-scoped read — returns null if the doc belongs to another project. */
  async getDocument(
    projectId: string,
    id: string,
  ): Promise<RagDocument | null> {
    const rows = await this.db
      .select()
      .from(ragDocuments)
      .where(and(eq(ragDocuments.id, id), eq(ragDocuments.projectId, projectId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listDocuments(
    projectId: string,
    opts: { status?: RagDocStatus; limit: number; offset: number },
  ): Promise<RagDocument[]> {
    const where = opts.status
      ? and(
          eq(ragDocuments.projectId, projectId),
          eq(ragDocuments.status, opts.status),
        )
      : eq(ragDocuments.projectId, projectId);

    return this.db
      .select()
      .from(ragDocuments)
      .where(where)
      .orderBy(desc(ragDocuments.createdAt))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  /** Documents eligible for `reindex-incomplete`: FAILED / PENDING / STALE only. */
  async listIncompleteDocuments(projectId: string): Promise<RagDocument[]> {
    return this.db
      .select()
      .from(ragDocuments)
      .where(
        and(
          eq(ragDocuments.projectId, projectId),
          inArray(ragDocuments.status, [...RAG_INCOMPLETE_STATUSES]),
        ),
      );
  }

  /** All documents in a project (used by a project-wide REINDEX). */
  async listAllDocuments(projectId: string): Promise<RagDocument[]> {
    return this.db
      .select()
      .from(ragDocuments)
      .where(eq(ragDocuments.projectId, projectId));
  }

  /** Mark a document STALE (source changed) without creating a new row. */
  async markDocumentStale(
    projectId: string,
    id: string,
    sourceHash?: string,
  ): Promise<void> {
    await this.db
      .update(ragDocuments)
      .set({
        status: 'STALE',
        updatedAt: new Date(),
        ...(sourceHash ? { sourceHash } : {}),
      })
      .where(
        and(eq(ragDocuments.id, id), eq(ragDocuments.projectId, projectId)),
      );
  }

  async patchDocument(
    projectId: string,
    id: string,
    patch: Partial<{
      status: RagDocStatus;
      chunkCount: number;
      tokenCount: number;
      sourceHash: string;
      normalizedFormat: string;
      error: string | null;
      indexedAt: Date | null;
    }>,
  ): Promise<void> {
    // Repository owns the invariant: the FINAL row must have a source hash once
    // status is INDEXED. Allowed if the patch carries one OR the row already has
    // one (e.g. recording an error on an already-INDEXED doc). Only read the row
    // when the patch omits the hash, so the worker's hot path stays read-free.
    if (patch.status === 'INDEXED' && patch.sourceHash == null) {
      const existing = await this.getDocument(projectId, id);
      if (!existing?.sourceHash) {
        throw new BadRequestException(
          'sourceHash is required when status is set to INDEXED',
        );
      }
    }
    await this.db
      .update(ragDocuments)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(eq(ragDocuments.id, id), eq(ragDocuments.projectId, projectId)),
      );
  }

  // ── Index jobs ─────────────────────────────────────────

  /**
   * Idempotent job creation via the composite UNIQUE(project_id, dedupe_key).
   * A duplicate dedupeKey returns the existing job with `created: false`, so the
   * same logical job is never enqueued twice.
   */
  async createIndexJob(
    input: CreateIndexJobInput,
  ): Promise<{ job: RagIndexJob; created: boolean }> {
    const inserted = await this.db
      .insert(ragIndexJobs)
      .values({
        projectId: input.projectId,
        documentId: input.documentId ?? null,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
      })
      .onConflictDoNothing({
        target: [ragIndexJobs.projectId, ragIndexJobs.dedupeKey],
      })
      .returning();

    if (inserted.length > 0) {
      return { job: inserted[0], created: true };
    }

    const existing = await this.db
      .select()
      .from(ragIndexJobs)
      .where(
        and(
          eq(ragIndexJobs.projectId, input.projectId),
          eq(ragIndexJobs.dedupeKey, input.dedupeKey),
        ),
      )
      .limit(1);

    if (!existing[0]) {
      throw new BadRequestException(
        'existing RAG index job not found after insert conflict',
      );
    }
    return { job: existing[0], created: false };
  }

  /**
   * Set the job RUNNING (and bump attempts). Unconditional by design so a BullMQ
   * retry can transition a previously FAILED job row back to RUNNING.
   */
  async markJobRunning(jobId: string): Promise<void> {
    await this.db
      .update(ragIndexJobs)
      .set({
        status: 'RUNNING',
        startedAt: new Date(),
        // Clear any prior terminal state so a BullMQ retry starts clean.
        finishedAt: null,
        error: null,
        updatedAt: new Date(),
        attempts: sql`${ragIndexJobs.attempts} + 1`,
      })
      .where(eq(ragIndexJobs.id, jobId));
  }

  async markJobCompleted(
    jobId: string,
    counts: { processedDocs: number; totalChunks: number },
  ): Promise<void> {
    await this.db
      .update(ragIndexJobs)
      .set({
        status: 'COMPLETED',
        processedDocs: counts.processedDocs,
        totalChunks: counts.totalChunks,
        finishedAt: new Date(),
        updatedAt: new Date(),
        error: null,
      })
      .where(eq(ragIndexJobs.id, jobId));
  }

  async markJobFailed(jobId: string, error: string): Promise<void> {
    await this.db
      .update(ragIndexJobs)
      .set({
        status: 'FAILED',
        error: error.slice(0, 8000),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ragIndexJobs.id, jobId));
  }

  // ── Chunks ─────────────────────────────────────────────

  /**
   * Replace a document's chunks atomically (delete-then-insert) so reindexing is
   * deterministic. Enforces the repository invariant that every chunk shares the
   * document's projectId — a chunk can never be written under another project.
   */
  async upsertChunks(
    documentId: string,
    projectId: string,
    chunks: RagChunkRow[],
  ): Promise<number> {
    for (const c of chunks) {
      if (c.projectId !== projectId) {
        throw new BadRequestException('chunk projectId mismatch');
      }
      if (c.documentId !== documentId) {
        throw new BadRequestException('chunk documentId mismatch');
      }
    }

    return this.db.transaction(async (tx) => {
      await tx.delete(ragChunks).where(eq(ragChunks.documentId, documentId));
      if (chunks.length > 0) {
        await tx.insert(ragChunks).values(chunks);
      }
      return chunks.length;
    });
  }

  // ── Status / usage ─────────────────────────────────────

  async getIndexStatus(projectId: string): Promise<{
    documents: Record<string, number>;
    activeJobs: number;
  }> {
    const byStatus = await this.db
      .select({
        status: ragDocuments.status,
        n: sql<number>`count(*)::int`,
      })
      .from(ragDocuments)
      .where(eq(ragDocuments.projectId, projectId))
      .groupBy(ragDocuments.status);

    const active = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ragIndexJobs)
      .where(
        and(
          eq(ragIndexJobs.projectId, projectId),
          inArray(ragIndexJobs.status, ['QUEUED', 'RUNNING']),
        ),
      );

    return {
      documents: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      activeJobs: active[0]?.n ?? 0,
    };
  }

  async usage(projectId: string): Promise<{
    documents: number;
    chunks: number;
    tokens: number;
    byStatus: Record<string, number>;
  }> {
    const docAgg = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${ragDocuments.tokenCount}),0)::int`,
      })
      .from(ragDocuments)
      .where(eq(ragDocuments.projectId, projectId));

    const chunkAgg = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ragChunks)
      .where(eq(ragChunks.projectId, projectId));

    const byStatus = await this.db
      .select({
        status: ragDocuments.status,
        n: sql<number>`count(*)::int`,
      })
      .from(ragDocuments)
      .where(eq(ragDocuments.projectId, projectId))
      .groupBy(ragDocuments.status);

    return {
      documents: docAgg[0]?.n ?? 0,
      chunks: chunkAgg[0]?.n ?? 0,
      tokens: docAgg[0]?.tokens ?? 0,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    };
  }

  // ── Search result mapping ──────────────────────────────

  /**
   * Map raw similarity hits (from VectorStoreService) into RAG search items.
   * Document id / chunk index / title are read from the embedding metadata that
   * the indexer stores alongside each chunk, so this needs no extra DB hit.
   */
  mapSearchResults(results: SimilarityResult[]): RagSearchResultItem[] {
    return results.map((r) => {
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      return {
        documentId: (meta.documentId as string) ?? null,
        chunkIndex:
          typeof meta.chunkIndex === 'number'
            ? (meta.chunkIndex as number)
            : null,
        title: (meta.title as string) ?? null,
        score: r.score,
        distance: r.distance,
        text: r.text,
      };
    });
  }

  /**
   * Hydrate raw similarity hits into full search items by joining each chunk
   * back to its document (title, bucket, object key). Scoped to the project, so
   * a hit can never surface a chunk from another project. Order follows the
   * similarity ranking; hits whose chunk no longer exists are dropped.
   */
  async hydrateSearchResults(
    projectId: string,
    results: SimilarityResult[],
    opts: { includeNonIndexed?: boolean } = {},
  ): Promise<RagSearchResultItem[]> {
    const ids = results.map((r) => r.entityId);
    if (ids.length === 0) return [];

    // Default: only return chunks whose document is INDEXED, so STALE/FAILED/
    // PROCESSING documents never leak results. Callers may opt in explicitly.
    const conditions = [
      eq(ragChunks.projectId, projectId),
      inArray(ragChunks.id, ids),
    ];
    if (!opts.includeNonIndexed) {
      conditions.push(eq(ragDocuments.status, 'INDEXED'));
    }

    const rows = await this.db
      .select({
        chunkId: ragChunks.id,
        documentId: ragChunks.documentId,
        chunkIndex: ragChunks.chunkIndex,
        content: ragChunks.content,
        title: ragDocuments.title,
        bucketName: ragDocuments.bucketName,
        objectKey: ragDocuments.objectKey,
      })
      .from(ragChunks)
      .innerJoin(ragDocuments, eq(ragChunks.documentId, ragDocuments.id))
      .where(and(...conditions));

    const byId = new Map(rows.map((r) => [r.chunkId, r]));
    const out: RagSearchResultItem[] = [];
    for (const r of results) {
      const h = byId.get(r.entityId);
      if (!h) continue;
      out.push({
        documentId: h.documentId,
        chunkIndex: h.chunkIndex,
        title: h.title,
        score: r.score,
        distance: r.distance,
        text: h.content,
        bucketName: h.bucketName,
        objectKey: h.objectKey,
      });
    }
    return out;
  }
}
