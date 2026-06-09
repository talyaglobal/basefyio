import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { RagService } from './rag.service';

/**
 * Unit tests via direct instantiation with mocks (no Nest DI container needed).
 * Covers: tenant/project scope, duplicate-ingest idempotency, project-scoped
 * read, reindex-incomplete target set, and search delegation/bounds.
 */
function build() {
  const prisma: any = {
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1', status: 'ACTIVE' }) },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ teamId: 't1', userId: 'u1' }) },
  };
  const repo: any = {
    createDocumentFromBucketObject: jest.fn(),
    createIndexJob: jest.fn(),
    getDocument: jest.fn(),
    listDocuments: jest.fn().mockResolvedValue([]),
    listIncompleteDocuments: jest.fn().mockResolvedValue([]),
    markDocumentStale: jest.fn().mockResolvedValue(undefined),
    getIndexStatus: jest.fn().mockResolvedValue({ documents: {}, activeJobs: 0 }),
    usage: jest.fn().mockResolvedValue({ documents: 0, chunks: 0, tokens: 0, byStatus: {} }),
    hydrateSearchResults: jest.fn().mockResolvedValue([]),
  };
  const storage: any = {
    getObject: jest.fn().mockResolvedValue({
      stream: { destroy: jest.fn() },
      stat: { size: 10, metaData: { 'content-type': 'text/plain' } },
    }),
  };
  const embedding: any = { generateEmbedding: jest.fn().mockResolvedValue(null) };
  const vectorStore: any = { findSimilar: jest.fn().mockResolvedValue([]) };
  const activity: any = { append: jest.fn().mockResolvedValue(undefined) };
  const queue: any = { add: jest.fn().mockResolvedValue(undefined) };
  const service = new RagService(prisma, repo, storage, embedding, vectorStore, activity, queue);
  return { service, prisma, repo, storage, embedding, vectorStore, activity, queue };
}

const dto = { bucketName: 'docs', objectKey: 'a/b.txt' } as any;

describe('RagService', () => {
  it('denies access to non-team-members', async () => {
    const { service, prisma } = build();
    prisma.teamMember.findUnique.mockResolvedValueOnce(null);
    await expect(service.usage('p1', 'intruder')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s when the project is not active', async () => {
    const { service, prisma } = build();
    prisma.project.findFirst.mockResolvedValueOnce(null);
    await expect(service.usage('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ingest is idempotent: duplicate register does not enqueue a second job', async () => {
    const { service, repo, queue, activity } = build();
    // first call: new doc + new job
    repo.createDocumentFromBucketObject.mockResolvedValueOnce({ document: { id: 'd1', sourceHash: null }, created: true });
    repo.createIndexJob.mockResolvedValueOnce({ job: { id: 'j1' }, created: true });
    await service.registerDocument('p1', 'u1', dto);
    // second call: existing doc + existing job (dedupe)
    repo.createDocumentFromBucketObject.mockResolvedValueOnce({ document: { id: 'd1', sourceHash: null }, created: false });
    repo.createIndexJob.mockResolvedValueOnce({ job: { id: 'j1' }, created: false });
    await service.registerDocument('p1', 'u1', dto);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(activity.append).toHaveBeenCalledTimes(1);
  });

  it('rejects ingest when the bucket object does not exist', async () => {
    const { service, storage } = build();
    storage.getObject.mockRejectedValueOnce(new Error('NoSuchKey'));
    await expect(service.registerDocument('p1', 'u1', dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cannot reindex a document from another project (scoped read returns null)', async () => {
    const { service, repo } = build();
    repo.getDocument.mockResolvedValueOnce(null); // doc not in this project
    await expect(
      service.reindex('p1', 'u1', { documentId: 'other-project-doc' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reindex-incomplete targets only the incomplete set from the repository', async () => {
    const { service, repo, queue } = build();
    repo.listIncompleteDocuments.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    repo.createIndexJob.mockResolvedValueOnce({ job: { id: 'j' }, created: true });
    const res = await service.reindexIncomplete('p1', 'u1');
    expect(repo.listIncompleteDocuments).toHaveBeenCalledWith('p1');
    expect(repo.createIndexJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'REINDEX_INCOMPLETE', documentId: null }),
    );
    expect(res.targetIds).toEqual(['a', 'b']);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('search delegates to the existing vector path scoped to the project + RAG entity type', async () => {
    const { service, embedding, vectorStore, repo } = build();
    embedding.generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    vectorStore.findSimilar.mockResolvedValueOnce([
      { entityId: 'c1', score: 0.9, distance: 0.1, text: 't', meta: {} },
    ]);
    await service.search('p1', 'u1', { q: 'hello', limit: 5, threshold: 0.3 } as any);
    expect(vectorStore.findSimilar).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      expect.objectContaining({
        entityTypes: ['rag_document_chunk'],
        projectId: 'p1',
        limit: 5,
        threshold: 0.3,
      }),
    );
    expect(repo.hydrateSearchResults).toHaveBeenCalledWith('p1', expect.any(Array));
  });

  it('search returns [] when embeddings are unavailable (graceful)', async () => {
    const { service, embedding, vectorStore } = build();
    embedding.generateEmbedding.mockResolvedValueOnce(null);
    const res = await service.search('p1', 'u1', { q: 'x', limit: 8, threshold: 0.45 } as any);
    expect(res).toEqual([]);
    expect(vectorStore.findSimilar).not.toHaveBeenCalled();
  });

  it('notifyObjectChanged (STALE owner) marks the doc STALE and enqueues a REINDEX', async () => {
    const { service, repo, queue } = build();
    repo.getDocument.mockResolvedValueOnce({ id: 'd1', projectId: 'p1' });
    repo.createIndexJob.mockResolvedValueOnce({ job: { id: 'j' }, created: true });
    await service.notifyObjectChanged('p1', 'd1', 'u1');
    expect(repo.markDocumentStale).toHaveBeenCalledWith('p1', 'd1');
    expect(repo.createIndexJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'REINDEX', documentId: 'd1' }),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('notifyObjectChanged 404s for a document in another project', async () => {
    const { service, repo } = build();
    repo.getDocument.mockResolvedValueOnce(null);
    await expect(service.notifyObjectChanged('p1', 'x', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
