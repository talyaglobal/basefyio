import { Readable } from 'node:stream';
import { RagIndexerService } from './rag-indexer.service';
import { sha256 } from './rag-util';

const BYTES = Buffer.from(
  'Sentence one explains the idea. Sentence two carries it forward. Sentence three concludes.',
);

function build() {
  const storage: any = {
    getObject: jest.fn().mockResolvedValue({ stream: Readable.from(BYTES) }),
  };
  const embedding: any = {
    embedContent: jest.fn().mockResolvedValue('emb-rec'),
  };
  const repo: any = {
    getDocument: jest.fn(),
    listAllDocuments: jest.fn().mockResolvedValue([]),
    listIncompleteDocuments: jest.fn().mockResolvedValue([]),
    upsertChunks: jest.fn().mockResolvedValue(1),
    patchDocument: jest.fn().mockResolvedValue(undefined),
  };
  const activity: any = { append: jest.fn().mockResolvedValue(undefined) };
  const indexer = new RagIndexerService(storage, embedding, repo, activity);
  return { indexer, storage, embedding, repo, activity };
}

const baseDoc = {
  id: 'd1',
  projectId: 'p1',
  bucketName: 'docs',
  objectKey: 'a.txt',
  title: 'A',
  contentType: 'text/plain',
  status: 'PENDING',
  sourceHash: null,
  granularity: 'sentence',
  chunkSize: 1000,
  chunkOverlap: 200,
} as any;

// patchDocument(projectId, id, patch) — patch is the 3rd arg.
const patches = (repo: any) =>
  repo.patchDocument.mock.calls.map((c: any[]) => c[2]);

describe('RagIndexerService', () => {
  it('indexes a document: embeds chunks, upserts, marks INDEXED (READY) with sourceHash', async () => {
    const { indexer, embedding, repo, activity } = build();
    const res = await indexer.indexDocument(baseDoc, 'INDEX');

    expect(res.chunks).toBeGreaterThan(0);
    expect(res.failed).toBe(false);
    expect(embedding.embedContent).toHaveBeenCalledWith(
      expect.any(String),
      'rag_document_chunk',
      expect.any(String),
      expect.objectContaining({ projectId: 'p1' }),
    );
    // patchDocument is always project-scoped (first arg = projectId)
    expect(repo.patchDocument).toHaveBeenCalledWith('p1', 'd1', expect.anything());
    expect(repo.upsertChunks).toHaveBeenCalledWith('d1', 'p1', expect.any(Array));
    const statuses = patches(repo).map((p: any) => p.status);
    expect(statuses).toContain('PROCESSING');
    expect(statuses).toContain('INDEXED');
    const indexed = patches(repo).find((p: any) => p.status === 'INDEXED');
    expect(indexed.sourceHash).toBe(sha256(BYTES));
    expect(activity.append).toHaveBeenCalled();
  });

  it('is idempotent: unchanged + already INDEXED is skipped', async () => {
    const { indexer, repo } = build();
    const doc = { ...baseDoc, status: 'INDEXED', sourceHash: sha256(BYTES) };
    const res = await indexer.indexDocument(doc, 'INDEX');
    expect(res).toEqual({ chunks: 0, failed: false });
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('re-indexes when the source hash changed (STALE path)', async () => {
    const { indexer, repo } = build();
    const doc = { ...baseDoc, status: 'INDEXED', sourceHash: 'old-different-hash' };
    const res = await indexer.indexDocument(doc, 'INDEX');
    expect(res.chunks).toBeGreaterThan(0);
    expect(repo.upsertChunks).toHaveBeenCalled();
  });

  it('forced REINDEX runs even when unchanged', async () => {
    const { indexer, repo } = build();
    const doc = { ...baseDoc, status: 'INDEXED', sourceHash: sha256(BYTES) };
    const res = await indexer.indexDocument(doc, 'REINDEX');
    expect(res.chunks).toBeGreaterThan(0);
    expect(repo.upsertChunks).toHaveBeenCalled();
  });

  it('marks FAILED and does not throw when the object cannot be read', async () => {
    const { indexer, storage, repo } = build();
    storage.getObject.mockRejectedValueOnce(new Error('NoSuchKey'));
    const res = await indexer.indexDocument(baseDoc, 'INDEX');
    expect(res).toEqual({ chunks: 0, failed: true });
    expect(patches(repo).some((p: any) => p.status === 'FAILED')).toBe(true);
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('failed reindex of an already-INDEXED doc keeps it INDEXED (records error, no status downgrade)', async () => {
    const { indexer, embedding, repo } = build();
    embedding.embedContent.mockRejectedValueOnce(new Error('embed boom'));
    const doc = { ...baseDoc, status: 'INDEXED', sourceHash: 'old-hash' };
    const res = await indexer.indexDocument(doc, 'REINDEX');
    expect(res).toEqual({ chunks: 0, failed: true });
    // never downgraded to FAILED; the error is recorded without re-asserting status
    expect(patches(repo).every((p: any) => p.status !== 'FAILED')).toBe(true);
    const last = patches(repo).at(-1);
    expect(last.status).toBeUndefined();
    expect(last.error).toContain('embed boom');
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('rejects a document that exceeds the max size', async () => {
    const { indexer, storage, repo } = build();
    const big = Buffer.alloc(26 * 1024 * 1024, 0x61); // > 25 MB cap
    storage.getObject.mockResolvedValueOnce({ stream: Readable.from(big) });
    const res = await indexer.indexDocument(baseDoc, 'INDEX');
    expect(res).toEqual({ chunks: 0, failed: true });
    expect(patches(repo).some((p: any) => p.status === 'FAILED')).toBe(true);
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  describe('runJob aggregation + target resolution', () => {
    it('aggregates failedDocs and totalChunks across the batch', async () => {
      const { indexer, repo } = build();
      repo.listAllDocuments.mockResolvedValueOnce([
        { ...baseDoc, id: 'a' },
        { ...baseDoc, id: 'b' },
      ]);
      (indexer as any).storage.getObject = jest
        .fn()
        .mockResolvedValueOnce({ stream: Readable.from(BYTES) })
        .mockRejectedValueOnce(new Error('NoSuchKey'));
      const res = await indexer.runJob({ jobId: 'j', projectId: 'p1', kind: 'REINDEX' });
      expect(res.processedDocs).toBe(2);
      expect(res.failedDocs).toBe(1);
      expect(res.totalChunks).toBeGreaterThan(0);
    });

    it('REINDEX_INCOMPLETE pulls only the incomplete set', async () => {
      const { indexer, repo } = build();
      await indexer.runJob({ jobId: 'j', projectId: 'p1', kind: 'REINDEX_INCOMPLETE' });
      expect(repo.listIncompleteDocuments).toHaveBeenCalledWith('p1');
      expect(repo.listAllDocuments).not.toHaveBeenCalled();
    });

    it('single-document job resolves that document only', async () => {
      const { indexer, repo } = build();
      repo.getDocument.mockResolvedValueOnce(null);
      await indexer.runJob({ jobId: 'j', projectId: 'p1', kind: 'REINDEX', documentId: 'd1' });
      expect(repo.getDocument).toHaveBeenCalledWith('p1', 'd1');
    });

    it('project-wide REINDEX pulls all documents', async () => {
      const { indexer, repo } = build();
      await indexer.runJob({ jobId: 'j', projectId: 'p1', kind: 'REINDEX' });
      expect(repo.listAllDocuments).toHaveBeenCalledWith('p1');
    });
  });
});
