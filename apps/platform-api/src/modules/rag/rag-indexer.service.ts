import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import { StorageService } from '../storage/storage.service';
import { EmbeddingService } from '../embedding/embedding.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { RagRepository } from './rag.repository';
import { chunk, normalizeToJson } from './rag-chunker';
import { buildChunkRows } from './rag-chunk-builder';
import { sha256 } from './rag-util';
import { RAG_CHUNK_ENTITY_TYPE, MAX_RAG_DOCUMENT_BYTES } from './rag.constants';
import type { RagIndexJobPayload } from './rag.service';
import type { RagDocument } from '../../db/drizzle/schema/rag';

/**
 * Commit-2 worker logic: turns a registered document into embedded chunks.
 *
 * Pipeline per document: read bytes from the existing bucket (StorageService) →
 * normalizeToJson → chunk (stored strategy) → embed each chunk via the existing
 * EmbeddingService (entityType `rag_document_chunk`, vector lands in
 * embeddings_store) → upsertChunks (transactional delete+insert, so old chunks
 * stay readable until the new set commits) → mark the document INDEXED ("READY")
 * / FAILED. Unchanged + already-INDEXED documents are skipped (idempotent).
 */
@Injectable()
export class RagIndexerService {
  private readonly logger = new Logger(RagIndexerService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly embedding: EmbeddingService,
    private readonly repo: RagRepository,
    private readonly activity: ProjectActivityService,
  ) {}

  /** Process one job: resolve target docs by kind, index each, return counts. */
  async runJob(
    payload: RagIndexJobPayload,
  ): Promise<{ processedDocs: number; failedDocs: number; totalChunks: number }> {
    const docs = await this.resolveTargets(payload);
    let totalChunks = 0;
    let failedDocs = 0;
    for (const doc of docs) {
      const result = await this.indexDocument(doc, payload.kind);
      totalChunks += result.chunks;
      if (result.failed) failedDocs += 1;
    }
    return { processedDocs: docs.length, failedDocs, totalChunks };
  }

  private async resolveTargets(
    payload: RagIndexJobPayload,
  ): Promise<RagDocument[]> {
    if (payload.kind === 'REINDEX_INCOMPLETE') {
      // Only FAILED / PENDING / STALE — never re-touch INDEXED docs here.
      return this.repo.listIncompleteDocuments(payload.projectId);
    }
    if (payload.documentId) {
      const doc = await this.repo.getDocument(
        payload.projectId,
        payload.documentId,
      );
      return doc ? [doc] : [];
    }
    return this.repo.listAllDocuments(payload.projectId);
  }

  /**
   * Index a single document. Returns the chunk count and whether it failed.
   * Never throws — failures are recorded on the document (and surfaced via
   * `failed`) so one bad doc does not abort a batch job, while the caller can
   * still escalate job status from the aggregate failure count.
   */
  async indexDocument(
    doc: RagDocument,
    kind: RagIndexJobPayload['kind'],
  ): Promise<{ chunks: number; failed: boolean }> {
    try {
      const bytes = await this.readObject(
        doc.projectId,
        doc.bucketName,
        doc.objectKey,
      );
      const sourceHash = sha256(bytes);

      // Idempotency: an unchanged, already-INDEXED document is skipped unless
      // this is an explicit forced REINDEX. The source-change case falls through
      // and re-indexes (the existing chunks remain until the swap commits).
      if (
        kind !== 'REINDEX' &&
        doc.status === 'INDEXED' &&
        doc.sourceHash === sourceHash
      ) {
        return { chunks: 0, failed: false };
      }

      // Keep an already-INDEXED document visible (status stays INDEXED) while it
      // re-indexes, so search keeps returning its current chunks until the
      // transactional swap commits. Only first-time / failed / stale docs flip
      // to PROCESSING.
      if (doc.status !== 'INDEXED') {
        await this.repo.patchDocument(doc.id, { status: 'PROCESSING' });
      }

      const normalized = normalizeToJson(bytes, doc.contentType ?? undefined);
      const rawChunks = chunk(normalized.text, {
        granularity: doc.granularity,
        chunkSize: doc.chunkSize,
        chunkOverlap: doc.chunkOverlap,
      });

      const rows = await buildChunkRows({
        documentId: doc.id,
        projectId: doc.projectId,
        rawChunks,
        genId: randomUUID,
        embed: (content, chunkId, chunkIndex) =>
          this.embedding.embedContent(
            content,
            RAG_CHUNK_ENTITY_TYPE,
            chunkId,
            {
              projectId: doc.projectId,
              extraMeta: {
                documentId: doc.id,
                chunkIndex,
                title: doc.title ?? null,
              },
            },
          ),
      });

      // Transactional swap inside the repository: readers see the old chunks
      // until this commits, so retrieval never has a gap.
      //
      // CLEANUP DEBT (commit 2): embeddings are written above before this swap,
      // so if the transaction fails, embeddings_store may retain vectors for
      // chunk ids that were never inserted. A later GC sweep should remove
      // embedding records whose chunk id no longer exists.
      await this.repo.upsertChunks(doc.id, doc.projectId, rows);

      const tokenCount = rows.reduce((sum, r) => sum + r.tokenCount, 0);
      await this.repo.patchDocument(doc.id, {
        status: 'INDEXED',
        chunkCount: rows.length,
        tokenCount,
        sourceHash,
        normalizedFormat: normalized.format,
        indexedAt: new Date(),
        error: null,
      });

      await this.activity.append(doc.projectId, {
        kind: ProjectActivityKind.RAG_INDEX_COMPLETED,
        title: `RAG document indexed: ${doc.bucketName}/${doc.objectKey}`,
        metadata: { documentId: doc.id, chunks: rows.length },
      });

      return { chunks: rows.length, failed: false };
    } catch (err: any) {
      this.logger.warn(
        `RAG index failed for document ${doc.id}: ${err?.message ?? err}`,
      );
      // An already-INDEXED document keeps its status on a failed reindex — its
      // existing chunks stay usable for search. Only first-time / failed / stale
      // documents become FAILED.
      const nextStatus = doc.status === 'INDEXED' ? 'INDEXED' : 'FAILED';
      await this.repo.patchDocument(doc.id, {
        status: nextStatus,
        error: String(err?.message ?? err).slice(0, 8000),
      });
      return { chunks: 0, failed: true };
    }
  }

  private async readObject(
    projectId: string,
    bucketName: string,
    objectKey: string,
  ): Promise<Buffer> {
    const { stream } = await this.storage.getObject(
      projectId,
      undefined,
      bucketName,
      objectKey,
    );
    return streamToBuffer(stream, MAX_RAG_DOCUMENT_BYTES);
  }
}

/**
 * Read a stream into a Buffer, rejecting once the accumulated size exceeds
 * `maxBytes` (and destroying the stream) so a huge object can't exhaust memory.
 */
function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(
          new Error(
            `Document exceeds the maximum RAG size of ${maxBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(Buffer.from(c));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
