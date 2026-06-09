import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { VectorStoreService } from '../embedding/vector-store.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { RAG_INDEX_QUEUE } from '../queue/queue.module';
import { RagRepository, type RagSearchResultItem } from './rag.repository';
import { ragJobDedupeKey } from './rag-util';
import { RAG_CHUNK_ENTITY_TYPE } from './rag.constants';
import type { RegisterRagDocumentDto } from './dto/register-rag-document.dto';
import type { ListRagDocumentsQuery } from './dto/list-rag-documents.query';
import type { ReindexDto } from './dto/reindex.dto';
import type { RagSearchQuery } from './dto/rag-search.query';

export interface RagIndexJobPayload {
  jobId: string;
  projectId: string;
  kind: 'INDEX' | 'REINDEX' | 'REINDEX_INCOMPLETE';
  documentId?: string | null;
}

/**
 * RAG storage service. Project-scoped, builds strictly on existing infra:
 *  - source bytes come from the existing StorageService (MinIO buckets);
 *  - embeddings go through the existing EmbeddingService / VectorStoreService
 *    (embeddings_store) — this module never touches that SQL directly;
 *  - metadata lives in the new Drizzle tables via RagRepository.
 *
 * NOTE (commit boundary): the actual chunk→embed→store WORKER and any vector
 * search hydration changes land in commit 2. This service wires routes,
 * validation, tenant scope, idempotency and job enqueueing only.
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: RagRepository,
    private readonly storage: StorageService,
    private readonly embedding: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
    private readonly activity: ProjectActivityService,
    @InjectQueue(RAG_INDEX_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Project access guard — mirrors the StorageService pattern: project must be
   * ACTIVE, and (when a user is present) the caller must be a team member.
   */
  private async assertProjectAccess(projectId: string, userId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (userId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!membership) {
        throw new ForbiddenException('Not a member of this team');
      }
    }
    return project;
  }

  // ── Documents ──────────────────────────────────────────

  /**
   * Register a bucket object as a RAG document and enqueue an index job.
   * Idempotent: a duplicate (bucketName, objectKey) returns the existing
   * document and does not enqueue a second job (dedupeKey).
   */
  async registerDocument(
    projectId: string,
    userId: string | undefined,
    dto: RegisterRagDocumentDto,
  ) {
    await this.assertProjectAccess(projectId, userId);

    // Validate the object exists in the existing bucket system. We only read its
    // stat and immediately discard the stream — no StorageService behavior change.
    let sizeBytes: number | undefined;
    let contentType: string | undefined;
    try {
      const { stream, stat } = await this.storage.getObject(
        projectId,
        userId,
        dto.bucketName,
        dto.objectKey,
      );
      stream.destroy();
      sizeBytes = stat.size;
      contentType = stat.metaData?.['content-type'];
    } catch {
      throw new NotFoundException(
        `Object not found in bucket: ${dto.bucketName}/${dto.objectKey}`,
      );
    }

    const { document, created } =
      await this.repo.createDocumentFromBucketObject({
        projectId,
        bucketName: dto.bucketName,
        objectKey: dto.objectKey,
        title: dto.title,
        contentType,
        sizeBytes,
        granularity: dto.granularity,
        chunkSize: dto.chunkSize,
        chunkOverlap: dto.chunkOverlap,
        createdBy: userId,
      });

    const dedupeKey = ragJobDedupeKey({
      projectId,
      kind: 'INDEX',
      documentId: document.id,
      sourceHash: document.sourceHash,
    });
    const { job, created: jobCreated } = await this.repo.createIndexJob({
      projectId,
      documentId: document.id,
      kind: 'INDEX',
      dedupeKey,
    });
    if (jobCreated) {
      await this.enqueue({
        jobId: job.id,
        projectId,
        kind: 'INDEX',
        documentId: document.id,
      });
    }

    if (created) {
      await this.activity.append(projectId, {
        userId,
        kind: ProjectActivityKind.RAG_DOCUMENT_REGISTERED,
        title: `RAG document registered: ${dto.bucketName}/${dto.objectKey}`,
        metadata: { documentId: document.id },
      });
    }

    return { document, created };
  }

  async listDocuments(
    projectId: string,
    userId: string | undefined,
    query: ListRagDocumentsQuery,
  ) {
    await this.assertProjectAccess(projectId, userId);
    return this.repo.listDocuments(projectId, {
      status: query.status,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  // ── Index control ──────────────────────────────────────

  async getIndexStatus(projectId: string, userId?: string) {
    await this.assertProjectAccess(projectId, userId);
    return this.repo.getIndexStatus(projectId);
  }

  async reindex(
    projectId: string,
    userId: string | undefined,
    dto: ReindexDto,
  ) {
    await this.assertProjectAccess(projectId, userId);

    let documentId: string | null = null;
    if (dto.documentId) {
      const doc = await this.repo.getDocument(projectId, dto.documentId);
      if (!doc) throw new NotFoundException('Document not found');
      documentId = doc.id;
    }

    const dedupeKey = ragJobDedupeKey({
      projectId,
      kind: 'REINDEX',
      documentId,
    });
    const { job, created } = await this.repo.createIndexJob({
      projectId,
      documentId,
      kind: 'REINDEX',
      dedupeKey,
    });
    if (created) {
      await this.enqueue({ jobId: job.id, projectId, kind: 'REINDEX', documentId });
      await this.activity.append(projectId, {
        userId,
        kind: ProjectActivityKind.RAG_REINDEX_REQUESTED,
        title: documentId
          ? `RAG reindex requested for document ${documentId}`
          : 'RAG reindex requested for project',
        metadata: { documentId, force: dto.force ?? false },
      });
    }
    return { job, created };
  }

  /**
   * Queue a job that will reprocess only FAILED / PENDING / STALE documents.
   * The target set is computed here (read-only) so callers see how many docs
   * will run; the actual reprocessing is the worker (commit 2).
   */
  async reindexIncomplete(projectId: string, userId?: string) {
    await this.assertProjectAccess(projectId, userId);

    const targets = await this.repo.listIncompleteDocuments(projectId);
    const dedupeKey = ragJobDedupeKey({
      projectId,
      kind: 'REINDEX_INCOMPLETE',
    });
    const { job, created } = await this.repo.createIndexJob({
      projectId,
      documentId: null,
      kind: 'REINDEX_INCOMPLETE',
      dedupeKey,
    });
    if (created) {
      await this.enqueue({
        jobId: job.id,
        projectId,
        kind: 'REINDEX_INCOMPLETE',
      });
    }
    return {
      job,
      created,
      targetCount: targets.length,
      targetIds: targets.map((d) => d.id),
    };
  }

  // ── Search / usage ─────────────────────────────────────

  /**
   * Semantic search over this project's RAG chunks. Uses the existing vector
   * search path (no SQL change): embed the query, then findSimilar scoped to
   * this project and the RAG chunk entity type. Returns [] when embeddings are
   * unavailable (graceful) or before any document has been indexed.
   */
  async search(
    projectId: string,
    userId: string | undefined,
    query: RagSearchQuery,
  ): Promise<RagSearchResultItem[]> {
    await this.assertProjectAccess(projectId, userId);

    const limit = query.limit ?? 8;
    const threshold = query.threshold ?? 0.45;

    const embedding = await this.embedding.generateEmbedding(query.q);
    if (!embedding) return [];

    const results = await this.vectorStore.findSimilar(embedding, {
      entityTypes: [RAG_CHUNK_ENTITY_TYPE],
      projectId,
      threshold,
      limit,
    });
    // Hydrate each hit against the RAG tables (project-scoped) for document
    // title / bucket / object key alongside the chunk text.
    return this.repo.hydrateSearchResults(projectId, results);
  }

  async usage(projectId: string, userId?: string) {
    await this.assertProjectAccess(projectId, userId);
    return this.repo.usage(projectId);
  }

  // ── Internal ───────────────────────────────────────────

  /** Enqueue a job for the (commit-2) worker. Never throws on queue failure. */
  private async enqueue(payload: RagIndexJobPayload): Promise<void> {
    try {
      await this.queue.add('rag-index', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      });
    } catch (err: any) {
      this.logger.warn('Failed to enqueue RAG index job', err?.message);
    }
  }
}
